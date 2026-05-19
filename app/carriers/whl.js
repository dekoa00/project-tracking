const { chromium } = require('playwright');

const QUERY_URL = 'https://www.wanhai.com/views/cargo_track_v2/tracking_query.xhtml';

async function trackWHL(trackingNumber, options = {}) {
  let browser;
  let context;
  let page;

  const headless = options.headless ?? (process.env.CI ? true : false);
  const slowMo = options.slowMo ?? 80;

  try {
    browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : (process.env.CI ? {} : { channel: 'msedge' })), headless, slowMo, args: ['--start-minimized'] });
    context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    page = await context.newPage();
    page.setDefaultTimeout(25000);

    await gotoQueryPage(page, trackingNumber);
    const listPage = await fillAndQuery(page, trackingNumber);
    const summary = await openDetailAndExtract(listPage, trackingNumber);

    return {
      status: 'success',
      carrier: 'WHL',
      trackingNumber,
      pod: summary.pod,
      eta: summary.eta,
      error: summary.error || '',
    };
  } catch (error) {
    return {
      status: 'error',
      carrier: 'WHL',
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

function clean(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function looksLikeWhlBookingNo(value) {
  // Examples from current file: 039GX40031, 039GX32218. These behave like Booking references on Wan Hai.
  return /^\d{3,}[A-Z]{1,3}\d{3,}$/i.test(clean(value));
}

async function checkCaptcha(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  if (/Additional security check is required|I am human|request is currently unavailable/i.test(text)) {
    throw new Error('Captcha detected on Wan Hai');
  }
}

async function gotoQueryPage(page, trackingNumber) {
  await page.goto(QUERY_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  await checkCaptcha(page);

  // Wan Hai often loads the page with the query field hidden behind a query-mode tab/radio.
  // On a fresh machine/session the element #q_ref_no1 can exist in the DOM but stay invisible
  // until we click the Booking/B/L/Cargo Tracking option first.
  await activateWhlQueryMode(page, trackingNumber);

  // Wait here with retry/reload so fillAndQuery does not fail just because the form renders late.
  await waitForWhlQueryInput(page, { timeout: 45000, trackingNumber });
}

const QUERY_INPUT_SELECTORS = [
  '#q_ref_no1',
  'input[name="q_ref_no1"]',
  'input[id*="q_ref_no"]',
  'input[name*="q_ref_no"]',
  'input[id*="ref_no"]',
  'input[name*="ref_no"]',
  'input[id*="bl"]',
  'input[name*="bl"]',
  'input[id*="booking"]',
  'input[name*="booking"]',
];

function getPreferredWhlQueryWords(trackingNumber) {
  // Wan Hai has several query modes. Booking-like refs such as 039GX40031 need the
  // Booking tab/option clicked before #q_ref_no1 becomes visible on some sessions.
  if (looksLikeWhlBookingNo(trackingNumber)) {
    return ['Booking No', 'Booking', 'Cargo Tracking', 'Tracking', 'B/L No', 'BL No', 'B/L'];
  }
  return ['B/L No', 'BL No', 'B/L', 'Bill of Lading', 'Cargo Tracking', 'Tracking', 'Booking No', 'Booking'];
}

async function clickVisibleByTextInFrames(page, words) {
  const escapedWords = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escapedWords.join('|'), 'i');

  for (const frame of page.frames()) {
    const locators = [
      frame.getByText(pattern).first(),
      frame.locator('label, button, a, span, div, td, li').filter({ hasText: pattern }).first(),
      frame.locator('input[type="radio"], input[type="checkbox"]').first(),
    ];

    for (const locator of locators) {
      const count = await locator.count().catch(() => 0);
      if (!count) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;

      const text = clean(await locator.innerText({ timeout: 1000 }).catch(() => ''));
      // Do not click the actual submit button while we are only trying to reveal the form.
      if (/^query$|^search$|submit|查詢|查询/i.test(text)) continue;

      await locator.click({ timeout: 4000 }).catch(() => null);
      await page.waitForTimeout(700);
      const found = await findVisibleLocatorInFrames(page);
      if (found) return true;
    }
  }

  return false;
}

async function activateWhlQueryMode(page, trackingNumber) {
  // Cookie/notice buttons are harmless if absent.
  for (const text of ['Accept', 'I Agree', 'Agree', 'OK', 'Close']) {
    await page.getByText(new RegExp(`^${text}$`, 'i')).click({ timeout: 1200 }).catch(() => {});
  }

  if (await findVisibleLocatorInFrames(page)) return true;

  const preferredWords = getPreferredWhlQueryWords(trackingNumber);
  if (await clickVisibleByTextInFrames(page, preferredWords)) return true;

  // Last fallback: click likely collapsed panels/buttons without submitting a search.
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate((words) => {
      const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const re = new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
      const candidates = Array.from(document.querySelectorAll('a, button, label, span, div, td, li, input[type="radio"], input[type="checkbox"]'));
      for (const el of candidates) {
        const text = clean(el.value || el.innerText || el.textContent || el.title || el.id || el.name || '');
        if (!text || /^query$|^search$|submit|查詢|查询/i.test(text)) continue;
        if (re.test(text)) {
          el.click();
          return text;
        }
      }
      return '';
    }, preferredWords).catch(() => '');

    if (clicked) {
      await page.waitForTimeout(1000);
      if (await findVisibleLocatorInFrames(page)) return true;
    }
  }

  return false;
}

async function findVisibleLocatorInFrames(page, selectors = QUERY_INPUT_SELECTORS) {
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const locator = frame.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (visible) return { frame, locator, selector };
    }

    // Last fallback: on the WHL query page there is usually only one meaningful visible text field.
    const visibleInputs = frame.locator('input:visible:not([type="hidden"]), textarea:visible');
    const count = await visibleInputs.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 5); i++) {
      const locator = visibleInputs.nth(i);
      const meta = await locator.evaluate(el => [
        el.id,
        el.name,
        el.placeholder,
        el.title,
        el.getAttribute('aria-label'),
        el.getAttribute('data-placeholder'),
      ].filter(Boolean).join(' ')).catch(() => '');
      if (/ref|booking|b\/?l|bill|track|cargo|query|no/i.test(meta) || count === 1) {
        return { frame, locator, selector: `visible input fallback #${i + 1}` };
      }
    }
  }
  return null;
}

async function waitForWhlQueryInput(page, { timeout = 45000, trackingNumber = '' } = {}) {
  const deadline = Date.now() + timeout;
  let reloaded = false;

  while (Date.now() < deadline) {
    await checkCaptcha(page);
    const found = await findVisibleLocatorInFrames(page);
    if (found) return found;

    await activateWhlQueryMode(page, trackingNumber);

    const remaining = deadline - Date.now();
    if (!reloaded && remaining < timeout * 0.55) {
      reloaded = true;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(3500);
      await activateWhlQueryMode(page, trackingNumber);
    } else {
      await page.waitForTimeout(1200);
    }
  }

  const title = await page.title().catch(() => '');
  const url = page.url();
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  throw new Error(
    `WHL query input not found after ${timeout}ms. URL=${url}; Title=${clean(title)}; Body=${clean(bodyText).slice(0, 220)}`
  );
}

async function fillAndQuery(page, trackingNumber) {
  const found = await waitForWhlQueryInput(page, { timeout: 45000, trackingNumber });
  const { frame, locator } = found;

  await locator.fill('').catch(async () => {
    await locator.click({ timeout: 5000 }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
  });

  await locator.type(trackingNumber, { delay: 30 }).catch(async () => {
    await locator.fill(trackingNumber);
  });

  const popupPromise = page.context().waitForEvent('page', { timeout: 22000 }).catch(() => null);

  const clicked = await frame.evaluate(() => {
    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const candidates = Array.from(document.querySelectorAll('input[type="button"], input[type="submit"], button, a'));
    const btn = candidates.find(el => /query|search|submit|查詢|查询/i.test(clean(el.value || el.innerText || el.textContent || el.title || '')))
      || candidates.find(el => /query|search|submit/i.test(clean(el.id || el.name || '')));
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }).catch(() => false);

  if (!clicked) throw new Error('WHL query button not found');

  const popup = await popupPromise;
  const listPage = popup || page;
  await listPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await listPage.waitForTimeout(2500);
  await checkCaptcha(listPage);

  const bodyText = await listPage.locator('body').innerText().catch(() => '');
  if (/no data|no result|not found|查無資料|查无资料/i.test(bodyText)) {
    throw new Error(`WHL no result found for ${trackingNumber}`);
  }

  return listPage;
}

async function getDetailLinkCandidates(listPage, trackingNumber) {
  const candidates = await listPage.evaluate(() => {
    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('a')).map((a, index) => ({
      index,
      text: clean(a.textContent),
      href: a.getAttribute('href') || '',
      onclick: a.getAttribute('onclick') || '',
    })).filter(item => /Booking Data|B\/L Data|BL Data|Bill of Lading/i.test(item.text));
  });

  const preferBooking = looksLikeWhlBookingNo(trackingNumber);
  candidates.sort((a, b) => {
    const aBooking = /Booking Data/i.test(a.text);
    const bBooking = /Booking Data/i.test(b.text);
    const aBL = /B\/L Data|BL Data|Bill of Lading/i.test(a.text);
    const bBL = /B\/L Data|BL Data|Bill of Lading/i.test(b.text);

    if (preferBooking) {
      if (aBooking && !bBooking) return -1;
      if (!aBooking && bBooking) return 1;
    } else {
      if (aBL && !bBL) return -1;
      if (!aBL && bBL) return 1;
    }
    return a.index - b.index;
  });

  return candidates;
}


async function waitForWhlDetailReady(detailPage, label = 'detail') {
  await detailPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await detailPage.waitForTimeout(2500);

  for (let attempt = 1; attempt <= 6; attempt++) {
    const bodyText = await detailPage.locator('body').innerText().catch(() => '');
    const cleaned = clean(bodyText);
    const stillLoading = /(^|\s)loading\.\.\./i.test(cleaned) || cleaned.length < 80;

    // WHL detail pages can open before the server-side table has rendered.
    // Do not extract while the popup still only shows "loading...".
    if (!stillLoading && /(Port|POD|ETA|ETD|Place of Delivery|Vessel|Voyage|B\/L|Booking|Container|CY|Date)/i.test(cleaned)) {
      return true;
    }

    await detailPage.waitForTimeout(3000);
  }

  // Some WHL popup pages stay stale on "loading...". One reload usually kicks the table render.
  await detailPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await detailPage.waitForTimeout(5000);

  for (let attempt = 1; attempt <= 4; attempt++) {
    const bodyText = await detailPage.locator('body').innerText().catch(() => '');
    const cleaned = clean(bodyText);
    const stillLoading = /(^|\s)loading\.\.\./i.test(cleaned) || cleaned.length < 80;

    if (!stillLoading && /(Port|POD|ETA|ETD|Place of Delivery|Vessel|Voyage|B\/L|Booking|Container|CY|Date)/i.test(cleaned)) {
      return true;
    }

    await detailPage.waitForTimeout(3000);
  }

  const finalText = await detailPage.locator('body').innerText().catch(() => '');
  throw new Error(`WHL ${label} page still loading or not ready after wait. Text: ${clean(finalText).slice(0, 180)}`);
}

async function openDetailAndExtract(listPage, trackingNumber) {
  const candidates = await getDetailLinkCandidates(listPage, trackingNumber);
  const tried = [];

  if (!candidates.length) {
    const direct = await extractPodEta(listPage);
    if (direct.pod || direct.eta) return direct;
    throw new Error('WHL Booking Data / B/L Data link not found');
  }

  for (const candidate of candidates) {
    tried.push(candidate.text || `link#${candidate.index}`);
    let detailPage = null;
    try {
      const popupPromise = listPage.context().waitForEvent('page', { timeout: 9000 }).catch(() => null);
      await listPage.evaluate((index) => {
        const link = Array.from(document.querySelectorAll('a'))[index];
        if (link) link.click();
      }, candidate.index);

      detailPage = await popupPromise;
      if (!detailPage) detailPage = listPage;

      await waitForWhlDetailReady(detailPage, candidate.text || `link#${candidate.index}`);
      await checkCaptcha(detailPage);

      const summary = await extractPodEta(detailPage);
      if (summary.pod || summary.eta) return summary;
    } catch (e) {
      tried[tried.length - 1] += ` (${e.message || e})`;
    } finally {
      if (detailPage && detailPage !== listPage) await detailPage.close().catch(() => {});
    }
  }

  throw new Error(`WHL detail opened but no POD/ETA extracted. Tried: ${tried.join(' -> ')}`);
}

async function extractPodEta(detailPage) {
  const result = await detailPage.evaluate(() => {
    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const datePattern = /\b\d{4}\/\d{2}\/\d{2}\b|\b[A-Z]{3}-\d{2}-\d{4}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/i;

    function firstDate(text) {
      const m = clean(text).match(datePattern);
      return m ? m[0] : '';
    }

    function pickPodFromCells(cells, labelIndex) {
      for (let i = labelIndex + 1; i < cells.length; i++) {
        const text = clean(cells[i]);
        if (!text) continue;
        if (datePattern.test(text)) continue;
        if (/ETA|ETD|DATE|TIME|VESSEL|VOYAGE/i.test(text)) continue;
        return text;
      }
      return '';
    }

    const rows = Array.from(document.querySelectorAll('tr'));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('th,td')).map(el => clean(el.textContent));
      if (!cells.length) continue;
      const joined = cells.join(' | ');
      const labelIndex = cells.findIndex(c => /Port of Discharg/i.test(c) || /^POD$/i.test(c));
      if (labelIndex >= 0) {
        return {
          pod: pickPodFromCells(cells, labelIndex),
          eta: firstDate(joined),
        };
      }
    }

    const text = clean(document.body.innerText);
    const podMatch = text.match(/Port of Discharg(?:ing|e)?\s*[:：]?\s*([^\n\r|]+?)(?:\s{2,}|ETA|ETD|\d{4}\/\d{2}\/\d{2}|$)/i);
    return {
      pod: podMatch ? clean(podMatch[1]) : '',
      eta: firstDate(text),
    };
  });

  const rawEta = clean(result.eta);
  const etaMatch = rawEta.match(/\b\d{4}\/\d{2}\/\d{2}\b|\b[A-Z]{3}-\d{2}-\d{4}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/i);

  return {
    pod: clean(result.pod),
    eta: etaMatch ? etaMatch[0] : rawEta,
  };
}

module.exports = trackWHL;

if (require.main === module) {
  const trackingNumber = process.argv[2] || '039GX40031';
  trackWHL(trackingNumber).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'success' ? 0 : 1);
  });
}
