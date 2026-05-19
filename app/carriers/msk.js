
const path = require('path');
const { chromium } = require('playwright');

const CONFIG = {
  trackingUrl: 'https://www.maersk.com/tracking/',
  browserChannel: process.env.PLAYWRIGHT_CHANNEL || (process.env.CI ? undefined : 'msedge'),
  userDataDir: path.resolve(__dirname, '.msk-edge-profile'),
  headless: process.env.CI ? true : false,
  slowMo: 90,
  navigationTimeoutMs: 45000,
  searchWaitMs: 7000,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function random(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cleanPod(value) {
  return normalize(String(value || '').replace(/^Arrived at\s+/i, ''));
}

function cleanEta(value) {
  return normalize(value);
}

async function acceptCookies(page) {
  const candidates = [
    page.locator('#onetrust-accept-btn-handler').first(),
    page.getByRole('button', { name: /accept all|accept cookies|allow all/i }).first(),
    page.locator('button:has-text("Accept all")').first(),
    page.locator('button:has-text("Accept")').first(),
    page.locator('button:has-text("Allow all")').first(),
  ];

  for (const button of candidates) {
    try {
      if (await button.isVisible({ timeout: 1200 }).catch(() => false)) {
        await button.click({ delay: random(50, 120) }).catch(() => {});
        await sleep(1000);
        return;
      }
    } catch {}
  }
}

async function gotoPage(page) {
  await page.goto(CONFIG.trackingUrl, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.navigationTimeoutMs,
  });

  await sleep(random(1800, 2600));
  await acceptCookies(page);
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(random(900, 1500));
}

async function findTrackingInput(page) {
  const candidates = [
    page.locator('input[placeholder*="BL or container number" i]').first(),
    page.locator('input.mc-input-track-input').first(),
    page.locator('input[placeholder*="tracking" i]').first(),
    page.locator('input[placeholder*="container" i]').first(),
    page.locator('input[placeholder*="booking" i]').first(),
    page.locator('input[type="text"]').first(),
  ];

  for (const input of candidates) {
    try {
      await input.waitFor({ state: 'visible', timeout: 6000 });
      return input;
    } catch {}
  }

  throw new Error('Không tìm thấy ô input tracking trên Maersk');
}

async function typeHuman(input, text) {
  for (const ch of text) {
    await input.type(ch, { delay: random(65, 130) });
  }
}

async function ensureOceanCargo(page) {
  const dropdown = page.getByRole('combobox').first();
  if (await dropdown.isVisible({ timeout: 3000 }).catch(() => false)) {
    const current = normalize(await dropdown.textContent().catch(() => ''));
    if (!/ocean cargo/i.test(current)) {
      await dropdown.click({ force: true }).catch(() => {});
      const opt = page.getByText(/Ocean cargo/i).first();
      if (await opt.isVisible({ timeout: 2000 }).catch(() => false)) {
        await opt.click({ force: true }).catch(() => {});
      }
    }
  }
}

async function clickTrackOrEnter(page, input) {
  const candidates = [
    page.getByRole('button', { name: /^track$/i }).first(),
    page.getByRole('button', { name: /track/i }).first(),
    page.locator('button:has-text("Track")').first(),
  ];

  for (const button of candidates) {
    try {
      if (await button.isVisible({ timeout: 1200 }).catch(() => false)) {
        await button.click({ delay: random(50, 120) }).catch(() => {});
        return;
      }
    } catch {}
  }

  await input.press('Enter').catch(() => {});
}

async function waitForResultPage(page, trackingNumber) {
  const expected = String(trackingNumber || '').trim();
  const checks = [
    page.getByText(/Latest event/i).first(),
    page.getByText(/^Arrived at /i).first(),
    page.getByText(/Bill of Lading number/i).first(),
    page.getByText(expected).first(),
  ];

  for (let i = 0; i < 20; i += 1) {
    for (const locator of checks) {
      try {
        if (await locator.isVisible({ timeout: 400 }).catch(() => false)) {
          await sleep(1200);
          return;
        }
      } catch {}
    }
    await sleep(800);
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/No results found/i.test(bodyText)) {
    throw new Error('MSK trả về No results found');
  }

  throw new Error('Không thấy trang kết quả tracking của MSK');
}

async function extractPodEta(page) {
  const fullText = normalize(await page.locator('body').innerText().catch(() => ''));
  const rawText = await page.locator('body').innerText().catch(() => '');
  const lines = rawText
    .split('\n')
    .map((s) => normalize(s))
    .filter(Boolean);

  // 1) Best effort via visible line parsing.
  let pod = '';
  let eta = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^Arrived at\s+(.+)$/i);
    if (!m) continue;
    pod = cleanPod(m[0]);
    const next = [lines[i + 1] || '', lines[i + 2] || ''].join(' ').trim();
    const dm = next.match(/\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}(?:\s+\d{1,2}:\d{2})?\b/i);
    if (dm && dm[0]) eta = cleanEta(dm[0]);
    break;
  }

  // 2) Fallback using regex on full body text.
  if (!pod) {
    const titleMatch = fullText.match(/Arrived at\s+([^·\n]+?)(?=\s+\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\s+Latest event|$)/i);
    if (titleMatch && titleMatch[0]) {
      pod = cleanPod(titleMatch[0]);
    }
  }
  if (!eta) {
    const etaMatch = fullText.match(/Arrived at[\s\S]{0,120}?(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\s+\d{1,2}:\d{2})/i);
    if (etaMatch && etaMatch[1]) eta = cleanEta(etaMatch[1]);
  }

  // 3) DOM fallback around the specific text node.
  if (!pod || !eta) {
    const titleLocator = page.getByText(/^Arrived at /i).first();
    if (await titleLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
      const titleText = normalize(await titleLocator.innerText().catch(() => ''));
      if (!pod) pod = cleanPod(titleText);
      if (!eta) {
        const wrapperText = normalize(
          await titleLocator.locator('xpath=ancestor::*[self::div or self::section][1]').innerText().catch(() => '')
        );
        const dm = wrapperText.match(/\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\s+\d{1,2}:\d{2}\b/i);
        if (dm && dm[0]) eta = cleanEta(dm[0]);
      }
    }
  }

  if (!pod) throw new Error('MSK: Không extract được POD ở block Arrived at');
  if (!eta) throw new Error('MSK: Không extract được ETA ở block Arrived at');

  return { pod, eta };
}

async function trackMSK(trackingNumber, options = {}) {
  let context;
  let page;

  const headless = options.headless ?? CONFIG.headless;
  const slowMo = options.slowMo ?? CONFIG.slowMo;

  try {
    context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
      ...(CONFIG.browserChannel ? { channel: CONFIG.browserChannel } : {}),
      headless,
      slowMo,
      viewport: process.env.CI ? { width: 1600, height: 1000 } : null,
      args: [
        ...(process.env.CI ? [] : ['--start-maximized']),
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15000);

    await gotoPage(page);
    await ensureOceanCargo(page);

    const input = await findTrackingInput(page);
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(random(250, 600));
    await input.click({ delay: random(50, 120) });
    await sleep(random(180, 350));
    await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await sleep(random(100, 180));
    await input.press('Delete').catch(() => {});
    await sleep(random(180, 320));
    await typeHuman(input, trackingNumber);
    await sleep(random(700, 1200));

    await clickTrackOrEnter(page, input);
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(CONFIG.searchWaitMs + random(500, 1200));

    await waitForResultPage(page, trackingNumber);
    const summary = await extractPodEta(page);

    return {
      status: 'success',
      carrier: 'MSK',
      trackingNumber,
      pod: summary.pod,
      eta: summary.eta,
      error: '',
    };
  } catch (error) {
    if (page) {
      await page.screenshot({
        path: path.resolve(__dirname, `debug-MSK-${Date.now()}.png`),
        fullPage: true,
      }).catch(() => {});
    }
    return {
      status: 'error',
      carrier: 'MSK',
      trackingNumber,
      pod: '',
      eta: '',
      error: error.message || String(error),
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

module.exports = trackMSK;

if (require.main === module) {
  const trackingNumber = process.argv[2] || '254012100';
  trackMSK(trackingNumber).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'success' ? 0 : 1);
  });
}
