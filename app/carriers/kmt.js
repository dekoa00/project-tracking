const { chromium } = require('playwright');

const MAIN_URL = 'https://www.ekmtc.com/index.html#/main';
const TRACK_URL = 'https://www.ekmtc.com/index.html#/cargo-tracking';

async function trackKMT(trackingNumber, options = {}) {
  let browser, context, page;
  const headless = options.headless ?? (process.env.CI ? true : false);
  const slowMo = options.slowMo ?? 120;

  try {
    browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : (process.env.CI ? {} : { channel: 'msedge' })), headless, slowMo });
    context = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(30000);

    await openCargoTracking(page);
    await searchTracking(page, trackingNumber);
    await waitForResults(page);
    const summary = await extractPodEta(page);

    return { status: 'success', carrier: 'KMT', trackingNumber, pod: summary.pod, eta: summary.eta, error: '' };
  } catch (error) {
    return { status: 'error', carrier: 'KMT', trackingNumber, pod: '', eta: '', error: error.message || String(error) };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function openCargoTracking(page) {
  // KMTC home keeps loading background assets/API calls. Do not wait for networkidle.
  // Go to main, click Cargo Tracking as soon as the DOM is ready, then wait only for the tracking input.
  await page.goto(MAIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);

  if (await findTrackingInput(page, 2500)) return;

  const clicked = await clickCargoTrackingFast(page);
  if (clicked) {
    await page.waitForTimeout(1500);
    if (await findTrackingInput(page, 8000)) return;
  }

  // Fallback: direct SPA route.
  await page.goto(TRACK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  if (await findTrackingInput(page, 15000)) return;

  // Last fallback: force hash route without waiting for whole page load.
  await page.evaluate(() => { window.location.hash = '#/cargo-tracking'; }).catch(() => {});
  await page.waitForTimeout(2500);
  if (await findTrackingInput(page, 15000)) return;

  throw new Error('KMTC: Không mở được màn Cargo Tracking / không thấy input BL No.');
}

async function clickCargoTrackingFast(page) {
  const candidates = [
    page.getByText('Cargo Tracking', { exact: true }).last(),
    page.locator('a:has-text("Cargo Tracking")').last(),
    page.locator('button:has-text("Cargo Tracking")').last(),
    page.locator('div:has-text("Cargo Tracking")').last(),
  ];

  for (const locator of candidates) {
    try {
      if (await locator.isVisible({ timeout: 3000 }).catch(() => false)) {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        await locator.click({ force: true, timeout: 3000 }).catch(async () => {
          const box = await locator.boundingBox().catch(() => null);
          if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        });
        return true;
      }
    } catch (_) {}
  }

  return await page.evaluate(() => {
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const items = Array.from(document.querySelectorAll('a, button, div, span'));
    const el = items.find((node) => visible(node) && /Cargo\s+Tracking/i.test(node.textContent || ''));
    if (el) {
      el.click();
      return true;
    }
    return false;
  }).catch(() => false);
}

async function findTrackingInput(page, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const input = await getTrackingInputLocator(page);
    if (input) return input;
    await page.waitForTimeout(400).catch(() => {});
  }
  return null;
}

async function getTrackingInputLocator(page) {
  const candidates = [
    page.locator('#blNo').first(),
    page.locator('input[name="blNo"]').first(),
    page.locator('input[id*="bl" i]').first(),
    page.locator('input[name*="bl" i]').first(),
    page.locator('input[placeholder*="B/L" i]').first(),
    page.locator('input[placeholder*="BL" i]').first(),
    page.locator('input[placeholder*="Booking" i]').first(),
    page.locator('input[type="text"]').first(),
  ];

  for (const candidate of candidates) {
    try {
      if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) return candidate;
    } catch (_) {}
  }

  return null;
}

async function searchTracking(page, trackingNumber) {
  const input = await findTrackingInput(page, 15000);
  if (!input) throw new Error('KMTC: Không thấy input BL No. để search');
  await input.click({ force: true }).catch(() => {});
  await input.fill('').catch(() => {});
  await input.type(trackingNumber, { delay: 35 }).catch(async () => {
    await input.fill(trackingNumber);
  });
  await page.waitForTimeout(250);

  const buttonCandidates = [
    page.getByRole('button', { name: /^search$/i }).first(),
    page.locator('button:has-text("Search")').first(),
    page.locator('input[type="button"][value*="Search" i]').first(),
  ];

  let clicked = false;
  for (const button of buttonCandidates) {
    if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
      await button.click({ force: true }).catch(() => {});
      clicked = true;
      break;
    }
  }
  if (!clicked) await input.press('Enter').catch(() => {});
  await page.waitForTimeout(1200);
}

async function waitForResults(page) {
  const candidates = [
    page.getByText('Cargo Tracking', { exact: true }),
    page.locator('table.tbl_con, table.tbl_search').first(),
    page.locator('td.td_left_line').first(),
    page.getByText('Arrival', { exact: true }),
  ];
  for (const c of candidates) {
    try {
      await c.waitFor({ state: 'visible', timeout: 20000 });
      break;
    } catch (_) {}
  }
  await page.waitForTimeout(1000);
}

async function extractPodEta(page) {
  const result = await page.evaluate(() => {
    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();

    const tables = Array.from(document.querySelectorAll('table'));
    for (const table of tables) {
      const headerCells = Array.from(table.querySelectorAll('tr:first-child th, tr:first-child td')).map(td => clean(td.textContent));
      const arrivalIdx = headerCells.findIndex(t => /^Arrival$/i.test(t));
      if (arrivalIdx < 0) continue;
      const bodyRows = Array.from(table.querySelectorAll('tr')).slice(1);
      const row = bodyRows.find(r => r.querySelectorAll('td').length > arrivalIdx);
      if (!row) continue;
      const cells = Array.from(row.querySelectorAll('td'));
      const cell = cells[arrivalIdx];
      if (!cell) continue;
      const raw = clean(cell.textContent);
      const dateMatch = raw.match(/\b\d{4}[./-]\d{2}[./-]\d{2}\s+\d{2}:\d{2}\b/);
      const eta = dateMatch ? dateMatch[0] : '';
      let pod = raw.replace(eta, '').trim();
      pod = pod.replace(/\s+/g, ' ');
      if (pod || eta) return { pod, eta };
    }

    const firstArrivalCell = document.querySelector('td.td_left_line:nth-child(7), td.td_left_line:nth-child(6)');
    if (firstArrivalCell) {
      const raw = clean(firstArrivalCell.textContent);
      const dateMatch = raw.match(/\b\d{4}[./-]\d{2}[./-]\d{2}\s+\d{2}:\d{2}\b/);
      const eta = dateMatch ? dateMatch[0] : '';
      let pod = raw.replace(eta, '').trim();
      return { pod, eta };
    }

    return { pod: '', eta: '' };
  });

  return { pod: cleanValue(result.pod), eta: cleanValue(result.eta) };
}

function cleanValue(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }

module.exports = trackKMT;
