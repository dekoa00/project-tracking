const { chromium } = require('playwright');

const TRACK_URL = 'https://ebusiness.sitcline.com/#/home';

async function trackSIT(trackingNumber, options = {}) {
  let browser;
  let context;
  let page;

  const headless = options.headless ?? (process.env.CI ? true : false);
  const slowMo = options.slowMo ?? 120;

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

    await gotoSitFast(page);
    await bypassNotice(page);
    await openCargoTracking(page);
    await searchTracking(page, trackingNumber);
    await waitForResults(page);

    const summary = await extractPodEta(page);

    return {
      status: 'success',
      carrier: 'SIT',
      trackingNumber,
      pod: summary.pod,
      eta: summary.eta,
      error: '',
    };
  } catch (error) {
    return {
      status: 'error',
      carrier: 'SIT',
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

async function bypassNotice(page) {
  const buttonNames = [
    /i know/i,
    /got it/i,
    /agree/i,
    /^ok$/i,
    /^confirm$/i,
    /^close$/i,
    /accept/i,
    /continue/i,
    /skip/i,
  ];

  for (const name of buttonNames) {
    try {
      const btn = page.getByRole('button', { name }).first();
      if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) {
        await btn.click({ timeout: 3000, force: true }).catch(() => {});
        await page.waitForTimeout(700);
        return;
      }
    } catch (_) {}
  }

  const selectors = [
    '.el-dialog__wrapper .el-button--primary',
    '.el-dialog__wrapper button',
    '.el-message-box__btns .el-button--primary',
    '.notice-dialog .el-button--primary',
    '.el-dialog__headerbtn',
    '.el-message-box__close',
    '.el-icon-close',
  ];

  for (const selector of selectors) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) {
        await btn.click({ timeout: 3000, force: true }).catch(() => {});
        await page.waitForTimeout(700);
        return;
      }
    } catch (_) {}
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

async function gotoSitFast(page) {
  // SITC home keeps loading background assets for a long time on slow network.
  // Do not wait for networkidle/load; only wait for DOM + first usable UI.
  await page.goto(TRACK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);

  // If the page is still painting, wait only for a minimal signal, then continue.
  await Promise.race([
    page.getByText('Cargo Tracking', { exact: true }).waitFor({ state: 'visible', timeout: 8000 }).catch(() => {}),
    page.locator('input.el-input__inner').first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {}),
    page.waitForTimeout(2500),
  ]).catch(() => {});
}

async function waitForSitLoadingDone(page, timeout = 25000) {
  // SITC shows ElementUI loading masks / spinners after search results start rendering.
  // Extraction must wait until those overlays disappear, otherwise table cells can be blank/old.
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const stillLoading = await page.evaluate(() => {
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const selectors = [
        '.el-loading-mask',
        '.el-loading-spinner',
        '.el-icon-loading',
        '[class*="loading"]',
        '[class*="Loading"]',
      ];
      return selectors.some((sel) =>
        Array.from(document.querySelectorAll(sel)).some((el) => visible(el))
      );
    }).catch(() => false);

    if (!stillLoading) {
      await page.waitForTimeout(800);
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function openCargoTracking(page) {
  // Click Cargo Tracking as soon as possible. Do not wait for full homepage load.
  const candidates = [
    page.getByText('Cargo Tracking', { exact: true }).first(),
    page.locator('text=Cargo Tracking').first(),
    page.locator('.select-box').getByText('Cargo Tracking', { exact: true }).first(),
    page.locator('[class*="cargo" i], [class*="tracking" i]').filter({ hasText: 'Cargo Tracking' }).first(),
  ];

  let clicked = false;
  for (const candidate of candidates) {
    try {
      if (await candidate.isVisible({ timeout: 2500 }).catch(() => false)) {
        await candidate.scrollIntoViewIfNeeded().catch(() => {});
        await candidate.click({ timeout: 3000, force: true }).catch(() => {});
        clicked = true;
        break;
      }
    } catch (_) {}
  }

  if (!clicked) {
    // DOM fallback: click first element containing exact Cargo Tracking text.
    await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('button, div, span, a, p'));
      const el = nodes.find((n) => /\bCargo Tracking\b/i.test(n.textContent || ''));
      if (el) el.click();
    }).catch(() => {});
  }

  // Wait for tracking form/input only. Home can keep loading in the background.
  for (let attempt = 0; attempt < 4; attempt++) {
    const hasInput = await page.locator('input.el-input__inner').last().isVisible({ timeout: 3500 }).catch(() => false);
    if (hasInput) {
      await waitForSitLoadingDone(page, 8000);
      return;
    }

    await bypassNotice(page);

    // Some SITC builds use hash routes. Try common cargo routes without failing if route differs.
    if (attempt === 1) {
      await page.evaluate(() => { window.location.hash = '#/cargoTracking'; }).catch(() => {});
    } else if (attempt === 2) {
      await page.evaluate(() => { window.location.hash = '#/cargo-tracking'; }).catch(() => {});
    }
    await page.waitForTimeout(1200);
  }

  throw new Error('SITC: Không mở được Cargo Tracking input');
}

async function searchTracking(page, trackingNumber) {
  const panel = page.locator('.select-box').filter({ has: page.getByText('Cargo Tracking', { exact: true }) }).first();
  const scopedInput = panel.locator('input.el-input__inner').last();
  const fallbackInput = page.locator('input.el-input__inner').last();

  let input = scopedInput;
  if (!(await input.count())) input = fallbackInput;

  await input.waitFor({ state: 'visible', timeout: 20000 });
  await input.click({ force: true });
  await input.fill('');
  await page.waitForTimeout(200);
  await input.type(trackingNumber, { delay: 50 });
  await page.waitForTimeout(300);

  const searchCandidates = [
    page.getByRole('button', { name: /^search$/i }).first(),
    panel.locator('button:has-text("Search")').first(),
    page.locator('button.submitBtn, button.el-button--primary').filter({ hasText: 'Search' }).first(),
    page.locator('button:has-text("Search")').first(),
  ];

  for (const button of searchCandidates) {
    try {
      if (await button.isVisible({ timeout: 1500 }).catch(() => false)) {
        await button.click({ timeout: 5000, force: true }).catch(() => {});
        await page.waitForTimeout(800);
        await waitForSitLoadingDone(page, 30000);
        return;
      }
    } catch (_) {}
  }

  await input.press('Enter').catch(() => {});
  await page.waitForTimeout(800);
  await waitForSitLoadingDone(page, 30000);
}

async function waitForResults(page) {
  // First wait until any loading screen from search disappears.
  await waitForSitLoadingDone(page, 35000);

  // Then wait for actual result content, not just a partially rendered table.
  const resultReady = await page.waitForFunction(() => {
    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const body = clean(document.body.innerText || '');

    if (/no data|no result|not found|no records/i.test(body)) return true;

    const rows = Array.from(document.querySelectorAll('.el-table__body-wrapper tbody tr, .el-table tbody tr'))
      .filter(visible);

    // Require a visible row with useful route/date text, because SITC can show skeleton/table before data finishes.
    return rows.some((row) => {
      const text = clean(row.innerText || row.textContent || '');
      return /(POD|ETA|Final Destination|Destination|Discharge|Arrival|\d{4}-\d{2}-\d{2})/i.test(text);
    }) || /Basic Information|Sailing Schedule Information|Final Destination/i.test(body);
  }, null, { timeout: 35000 }).then(() => true).catch(() => false);

  if (!resultReady) {
    throw new Error('SITC: Result table did not finish loading');
  }

  await waitForSitLoadingDone(page, 10000);
  await page.waitForTimeout(1200);
}

async function extractPodEta(page) {
  const result = await page.evaluate(() => {
    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const looksLikeDateTime = (v) => /^\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?$/.test(clean(v));

    const tables = Array.from(document.querySelectorAll('.el-table'));

    for (const wrap of tables) {
      const headerTable = wrap.querySelector('.el-table__header-wrapper table') || wrap.querySelector('table');
      const bodyTable = wrap.querySelector('.el-table__body-wrapper table') || wrap.querySelector('table');
      if (!headerTable || !bodyTable) continue;

      const headers = Array.from(headerTable.querySelectorAll('thead th, tr:first-child th, tr:first-child td'))
        .map(th => clean(th.textContent));

      const podIdx = headers.findIndex(t => /^POD$/i.test(t));
      const etaAtaIdx = headers.findIndex(t => /^ETA\/ATA$/i.test(t));
      const scheduleEtaIdx = headers.findIndex(t => /^Schedule\s*ETA$/i.test(t));
      if (podIdx < 0 || (etaAtaIdx < 0 && scheduleEtaIdx < 0)) continue;

      const firstRow = bodyTable.querySelector('tbody tr') || bodyTable.querySelector('tr');
      if (!firstRow) continue;

      const cells = Array.from(firstRow.querySelectorAll('td'));
      const podCell = cells[podIdx];
      const etaAtaCell = etaAtaIdx >= 0 ? cells[etaAtaIdx] : null;
      const scheduleEtaCell = scheduleEtaIdx >= 0 ? cells[scheduleEtaIdx] : null;

      const pod = clean(podCell ? podCell.textContent : '');
      const etaAtaRaw = clean(etaAtaCell ? etaAtaCell.textContent : '');
      const scheduleEtaRaw = clean(scheduleEtaCell ? scheduleEtaCell.textContent : '');

      // SITC: ETA/ATA is actual arrival. When it is empty or "-", fall back to Schedule ETA.
      const etaSource = /^(?:-|—|–)?$/.test(etaAtaRaw) ? scheduleEtaRaw : etaAtaRaw;
      const etaMatch = etaSource.match(/\b\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\b/);
      const eta = etaMatch ? etaMatch[0] : '';

      if (pod || eta) return { pod, eta };
    }

    // Fallback by visible cell positions. Current SITC schedule table is:
    // VesselName | Voyage | POL | Schedule ETD | ETD/ATD | POD | Schedule ETA | ETA/ATA | ETB/ATB
    const rows = Array.from(document.querySelectorAll('.el-table__body-wrapper tbody tr, table tbody tr'));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map(td => clean(td.textContent));
      if (cells.length < 8) continue;
      const pod = cells[5] || '';
      const etaAtaRaw = cells[7] || '';
      const scheduleEtaRaw = cells[6] || '';
      const etaSource = /^(?:-|—|–)?$/.test(etaAtaRaw) ? scheduleEtaRaw : etaAtaRaw;
      const etaMatch = etaSource.match(/\b\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\b/);
      const eta = etaMatch ? etaMatch[0] : '';
      if (pod || eta) return { pod, eta };
    }

    // Legacy fallback by known ElementUI column classes from older SIT table builds.
    const firstBodyRow = document.querySelector('.el-table__body-wrapper tbody tr');
    if (firstBodyRow) {
      const podCell = firstBodyRow.querySelector('td[class*="column_9"] .cell, td[class*="column_8"] .cell');
      const etaAtaCell = firstBodyRow.querySelector('td[class*="column_11"] .cell, td[class*="column_10"] .cell');
      const scheduleEtaCell = firstBodyRow.querySelector('td[class*="column_10"] .cell, td[class*="column_9"] .cell');
      const pod = clean(podCell ? podCell.textContent : '');
      const etaAtaRaw = clean(etaAtaCell ? etaAtaCell.textContent : '');
      const scheduleEtaRaw = clean(scheduleEtaCell ? scheduleEtaCell.textContent : '');
      const etaSource = /^(?:-|—|–)?$/.test(etaAtaRaw) ? scheduleEtaRaw : etaAtaRaw;
      const etaMatch = etaSource.match(/\b\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\b/);
      const eta = etaMatch ? etaMatch[0] : '';
      return { pod, eta };
    }
    return { pod: '', eta: '' };
  });

  return {
    pod: cleanValue(result.pod),
    eta: cleanValue(result.eta),
  };
}

function cleanValue(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

module.exports = trackSIT;

if (require.main === module) {
  const trackingNumber = process.argv[2] || 'SITSGMNG491503';
  trackSIT(trackingNumber).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'success' ? 0 : 1);
  });
}
