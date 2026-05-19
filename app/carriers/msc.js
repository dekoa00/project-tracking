const { chromium } = require('playwright');

const TRACK_URL = 'https://www.msc.com/en/track-a-shipment';

const CONFIG = {
  headless: process.env.CI ? true : false,
  slowMo: 120,
  navigationTimeout: 60000,
  resultTimeout: 25000,
  shortWait: 500,
  mediumWait: 1800,
  longWait: 3500,
};

async function trackMSC(trackingNumber, options = {}) {
  let browser;
  let context;
  let page;

  const headless = options.headless ?? CONFIG.headless;
  const slowMo = options.slowMo ?? CONFIG.slowMo;

  try {
    browser = await chromium.launch({
      ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : (process.env.CI ? {} : { channel: 'msedge' })),
      headless,
      slowMo,
    });

    context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
    });

    page = await context.newPage();
    page.setDefaultTimeout(30000);

    await gotoTrackingPage(page);
    await fillAndSearchTracking(page, trackingNumber);
    await ensureContainersSection(page);

    const pod = await extractPortOfDischarge(page);
    let eta = await extractPodEta(page);

    // MSC completed/discharged shipments often have blank POD ETA in the summary.
    // In that case, expand the first container card and take the date of
    // "Import Discharged from Vessel" at the POD as the actual POD date.
    if (!eta) {
      const fallback = await extractEtaFromDischargedTimeline(page, pod);
      if (fallback && fallback.eta) eta = fallback.eta;
    }

    return {
      status: 'success',
      carrier: 'MSC',
      trackingNumber,
      pod,
      eta,
      error: '',
    };
  } catch (error) {
    return {
      status: 'error',
      carrier: 'MSC',
      trackingNumber,
      pod: '',
      eta: '',
      error: error && error.message ? error.message : String(error),
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeLocation(value) {
  return normalizeKey(value)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bPHILIPPINES\b/g, 'PH')
    .replace(/\bVIETNAM\b/g, 'VN')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function locationMatches(eventLocation, pod) {
  const a = normalizeLocation(eventLocation);
  const b = normalizeLocation(pod);
  if (!a || !b) return true;
  return a.includes(b) || b.includes(a) || a.replace(/\bPH\b/g, '').trim() === b.replace(/\bPH\b/g, '').trim();
}

function looksLikeDate(value) {
  const text = normalizeText(value);
  return (
    /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text) ||
    /^\d{1,2}[.-]\d{1,2}[.-]\d{2,4}$/.test(text) ||
    /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(text) ||
    /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/.test(text) ||
    /^\w{3,9}[ -]\d{1,2}[, -]\d{4}$/i.test(text)
  );
}

async function wait(page, ms) {
  await page.waitForTimeout(ms).catch(() => {});
}

async function closeCookieBanner(page) {
  const candidates = [
    page.getByRole('button', { name: /accept all/i }),
    page.getByRole('button', { name: /^accept$/i }),
    page.getByRole('button', { name: /agree/i }),
    page.getByRole('button', { name: /allow all/i }),
    page.locator('button:has-text("Accept All")'),
    page.locator('button:has-text("Accept")'),
    page.locator('button:has-text("I Agree")'),
    page.locator('#onetrust-accept-btn-handler'),
    page.locator('button[aria-label*="Accept" i]'),
    page.locator('button[id*="accept" i]'),
  ];

  for (const locator of candidates) {
    try {
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
          await el.click({ timeout: 1500, force: true }).catch(() => {});
          await wait(page, 500);
          return true;
        }
      }
    } catch (_) {}
  }
  return false;
}

async function gotoTrackingPage(page) {
  await page.goto(TRACK_URL, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.navigationTimeout,
  });

  await wait(page, 1500);
  await closeCookieBanner(page);
  await wait(page, 1000);
}

async function getTrackingInput(page) {
  const candidates = [
    page.locator('#trackingNumber'),
    page.getByPlaceholder('Enter a Container/Bill of Lading Number'),
    page.locator('input[placeholder*="Container/Bill of Lading"]'),
    page.locator('input[data-type="search"]'),
    page.locator('input[type="search"]'),
  ];

  for (const locator of candidates) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: 4000 });
      return locator.first();
    } catch (_) {}
  }

  throw new Error('MSC: Cannot find tracking input');
}

async function ensureContainerBillMode(page) {
  const input = page.locator('#trackingNumber');
  if (await input.count()) return;

  const radio = page.getByText('Container/Bill of Lading Number', { exact: false }).first();
  if (await radio.isVisible({ timeout: 3000 }).catch(() => false)) {
    await radio.click({ force: true }).catch(() => {});
  }
}

async function triggerSearch(page, input) {
  const candidates = [
    page.locator('button.msc-search-autocomplete__button:not([disabled])').last(),
    page.locator('button[class*="msc-search-autocomplete__button"]:not([disabled])').last(),
    page.locator('button.msc-search-autocomplete__search:not([disabled])').last(),
    page.locator('button[class*="search-autocomplete__search"]:not([disabled])').last(),
    page.getByRole('button', { name: /search/i }).last(),
  ];

  for (const locator of candidates) {
    try {
      if (await locator.isVisible({ timeout: 2000 }).catch(() => false)) {
        await locator.click({ timeout: 5000, force: true });
        await wait(page, 800);
        return true;
      }
    } catch (_) {}
  }

  await input.press('Enter').catch(() => {});
  await wait(page, 800);
  return true;
}

async function fillAndSearchTracking(page, trackingNumber) {
  await ensureContainerBillMode(page);
  const input = await getTrackingInput(page);

  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ force: true });
  await input.fill('');
  await input.fill(String(trackingNumber || '').trim());
  await input.dispatchEvent('input').catch(() => {});
  await input.dispatchEvent('change').catch(() => {});
  await wait(page, 500);

  await triggerSearch(page, input);

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await closeCookieBanner(page);
  await wait(page, 3500);

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/No results found for this Bill of Lading number/i.test(bodyText)) {
    throw new Error('MSC: No result found for this Bill of Lading number');
  }
  if (/No results found/i.test(bodyText)) {
    throw new Error('MSC: No result found');
  }

  await waitForResults(page, trackingNumber);
}

async function waitForResults(page, trackingNumber) {
  const expected = String(trackingNumber || '').trim().toUpperCase();

  await page.waitForFunction(
    ({ expected }) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

      const body = norm(document.body && document.body.innerText);
      if (expected && body.includes(`BILL OF LADING: ${expected}`)) return true;
      if (body.includes('BILL OF LADING:') && body.includes('PORT OF DISCHARGE')) return true;
      if (body.includes('CONTAINERS') && body.includes('LATEST MOVE')) return true;

      return Array.from(document.querySelectorAll('.msc-flow-tracking__content, .msc-flow-tracking__container, .msc-flow-tracking__port'))
        .some((el) => visible(el));
    },
    { expected },
    { timeout: CONFIG.resultTimeout }
  );

  await wait(page, 1200);
}

async function ensureContainersSection(page) {
  const candidates = [
    page.locator('text=/^Containers$/i').first(),
    page.locator('text=/Latest move/i').first(),
    page.locator('.msc-flow-tracking__content').first(),
    page.locator('.msc-flow-tracking__port').first(),
  ];

  for (let attempt = 0; attempt < 4; attempt++) {
    for (const locator of candidates) {
      try {
        await locator.waitFor({ state: 'visible', timeout: 4000 });
        return true;
      } catch (_) {}
    }
    await closeCookieBanner(page);
    await wait(page, 2000);
  }

  throw new Error('MSC: Cannot find containers section');
}

async function extractPortOfDischarge(page) {
  const value = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const upper = (s) => norm(s).toUpperCase();
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

    const leafText = (el) => norm(el.innerText || el.textContent || '');
    const elements = Array.from(document.querySelectorAll('div, span, p, strong'))
      .filter(visible)
      .map((el) => ({ el, text: leafText(el) }))
      .filter((item) => item.text && item.text.length <= 120);

    // Prefer exact visible label/value pairs from the B/L summary.
    for (let i = 0; i < elements.length; i++) {
      if (upper(elements[i].text) !== 'PORT OF DISCHARGE') continue;
      for (let j = i + 1; j < Math.min(i + 8, elements.length); j++) {
        const text = elements[j].text;
        const u = upper(text);
        if (!text || u === 'PORT OF DISCHARGE') continue;
        if (['SHIPPED TO', 'TRANSHIPMENT', 'PRICE CALCULATION DATE*', 'PRICE CALCULATION DATE'].includes(u)) break;
        if (!u.includes('PORT OF DISCHARGE') && !u.includes('SHIPPED TO')) return text;
      }
    }

    const body = norm(document.body && document.body.innerText);
    const match = body.match(/Port of Discharge\s+(.+?)\s+Shipped To/i);
    if (match && match[1]) return norm(match[1]);

    return '';
  });

  return cleanPod(value);
}

async function extractPodEta(page) {
  const value = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

    // Only use an explicit POD ETA block. Do not use Price Calculation Date.
    const blocks = Array.from(document.querySelectorAll('.msc-flow-tracking__data'));
    for (const block of blocks) {
      if (!visible(block)) continue;
      const headingEl = block.querySelector(':scope .data-heading');
      const valueEl = block.querySelector(':scope .data-value');
      if (!headingEl || !valueEl || !visible(headingEl) || !visible(valueEl)) continue;

      const headingText = norm(headingEl.textContent).toUpperCase();
      if (headingText !== 'POD ETA') continue;

      const text = norm(valueEl.textContent);
      if (text) return text;
    }

    return '';
  });

  return cleanEta(value);
}

async function getVisibleTimelineRows(page) {
  const rows = page.locator('.msc-flow-tracking__port');
  const count = await rows.count().catch(() => 0);
  const result = [];

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    if (await row.isVisible().catch(() => false)) result.push(row);
  }

  return result;
}

async function getFirstContainerContent(page) {
  const candidates = [
    page.locator('.msc-flow-tracking__content').filter({ hasText: /Container/i }).first(),
    page.locator('.msc-flow-tracking__container').filter({ hasText: /Container/i }).first(),
    page.locator('div').filter({ hasText: /Latest move/i }).first(),
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 3000 });
      return locator;
    } catch (_) {}
  }

  throw new Error('MSC: Cannot find first container content block');
}

async function expandFirstContainerByContentClick(page) {
  if ((await getVisibleTimelineRows(page)).length > 0) return true;

  await ensureContainersSection(page);
  const content = await getFirstContainerContent(page);
  await content.scrollIntoViewIfNeeded().catch(() => {});
  await wait(page, 800);

  const box = await content.boundingBox().catch(() => null);
  if (box) {
    // Click inside the main content block, not the + icon. This expands both
    // blank-summary and completed/checkmark MSC rows.
    const x = box.x + Math.min(box.width * 0.35, box.width - 20);
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y).catch(() => {});
    await wait(page, CONFIG.mediumWait);
    if ((await getVisibleTimelineRows(page)).length > 0) return true;
  }

  // Fallback: click the content element itself, still avoiding explicit + button logic.
  await content.click({ force: true, timeout: 2000 }).catch(() => {});
  await wait(page, CONFIG.mediumWait);

  return (await getVisibleTimelineRows(page)).length > 0;
}

async function extractEtaFromDischargedTimeline(page, pod) {
  let expanded = await expandFirstContainerByContentClick(page);
  if (!expanded) {
    await closeCookieBanner(page);
    await wait(page, 1500);
    expanded = await expandFirstContainerByContentClick(page);
  }
  if (!expanded) return null;

  await wait(page, 1200);
  const events = await extractTimelineEvents(page);

  for (const event of events) {
    if (!/import\s+discharged\s+from\s+vessel/i.test(event.description)) continue;
    if (!locationMatches(event.location, pod)) continue;
    return {
      eta: cleanEta(event.date) || event.date,
      event,
    };
  }

  return null;
}

async function extractTimelineEvents(page) {
  const rows = await getVisibleTimelineRows(page);
  const parsed = [];

  for (let i = 0; i < rows.length; i++) {
    const values = await rows[i].locator('span.data-value').evaluateAll((nodes) =>
      nodes
        .map((node) => String(node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
    ).catch(() => []);

    let fields = values;
    if (fields.length < 4) {
      const text = await rows[i].innerText().catch(() => '');
      fields = String(text || '')
        .split(/\n+/)
        .map((v) => normalizeText(v))
        .filter(Boolean)
        .filter((v) => !['DATE', 'LOCATION', 'DESCRIPTION', 'EMPTY/LADEN/VESSEL/VOYAGE', 'EQUIPMENT HANDLING FACILITY NAME'].includes(v.toUpperCase()));
    }

    if (fields.length < 3) continue;

    const event = {
      date: normalizeText(fields[0] || ''),
      location: normalizeText(fields[1] || ''),
      description: normalizeText(fields[2] || ''),
      vesselVoyage: normalizeText(fields[3] || ''),
      facility: normalizeText(fields[4] || ''),
      raw: fields,
    };

    if (!event.date || !event.location || !event.description) continue;
    if (!looksLikeDate(event.date)) continue;
    parsed.push(event);
  }

  return parsed;
}

function cleanPod(value) {
  return normalizeText(value)
    .replace(/,\s*PH$/i, ', PH')
    .replace(/\s+\(\s*\)$/g, '')
    .trim();
}

function cleanEta(value) {
  const text = normalizeText(value);
  if (!text) return '';

  const looksValid = [
    /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/,
    /^\d{4}[./-]\d{1,2}[./-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/,
    /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/,
    /^\w{3,9}[ -]\d{1,2}[, -]\d{4}(?:\s+\d{1,2}:\d{2})?$/i,
  ].some((pattern) => pattern.test(text));

  return looksValid ? text : '';
}

module.exports = trackMSC;

if (require.main === module) {
  const trackingNumber = process.argv[2] || 'MEDUR7234798';
  trackMSC(trackingNumber).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'success' ? 0 : 1);
  });
}
