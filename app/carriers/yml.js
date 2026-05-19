const { chromium } = require('playwright');

const TRACK_URL = 'https://www.yangming.com/en';

async function trackYML(trackingNumber, options = {}) {
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

    context = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto(TRACK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    await acceptCookie(page);
    await closeFraudNotice(page);
    await openCargoTracking(page);
    await closeFraudNotice(page);
    await searchTracking(page, trackingNumber);
    const resultState = await waitForResults(page);

    if (resultState && resultState.notFound) {
      return {
        status: 'error',
        carrier: 'YML',
        trackingNumber,
        pod: '',
        eta: '',
        error: 'YML tracking no longer available on system',
      };
    }

    const summary = await extractPodEta(page);

    return {
      status: 'success',
      carrier: 'YML',
      trackingNumber,
      pod: summary.pod,
      eta: summary.eta,
      error: '',
    };
  } catch (error) {
    return {
      status: 'error',
      carrier: 'YML',
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
    page.getByRole('button', { name: /accept/i }),
    page.getByRole('button', { name: /accept all/i }),
    page.locator('button:has-text("Accept")'),
    page.locator('button:has-text("Accept All")'),
    page.locator('[aria-label*="accept" i]'),
  ];

  for (const locator of candidates) {
    try {
      const btn = locator.first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click({ timeout: 4000, force: true }).catch(() => {});
        await page.waitForTimeout(600);
        return;
      }
    } catch (_) {}
  }
}


async function closeFraudNotice(page) {
  const closeCandidates = [
    page.locator('button[aria-label*=close i]').last(),
    page.getByRole('button', { name: /close/i }).last(),
    page.locator('button:has-text("×")').last(),
    page.locator('button:has-text("✕")').last(),
    page.locator('text="×"').last(),
    page.locator('text="✕"').last(),
  ];

  for (const locator of closeCandidates) {
    try {
      if (await locator.isVisible({ timeout: 1200 }).catch(() => false)) {
        await locator.click({ timeout: 3000, force: true }).catch(() => {});
        await page.waitForTimeout(700).catch(() => {});
        return true;
      }
    } catch (_) {}
  }

  try {
    const closed = await page.evaluate(() => {
      const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const dialogs = Array.from(document.querySelectorAll('[role=dialog], .modal, .popup, .notice, div'));
      const overlay = dialogs.find(el => /fraud|scam|prevention|vigilance/i.test(clean(el.textContent || '')) && clean(el.textContent || '').length > 40);
      if (overlay) {
        const nodes = [overlay, ...overlay.querySelectorAll('*')];
        const close = nodes.find(el => {
          const txt = clean(el.textContent || '');
          const cls = String(el.className || '').toLowerCase();
          const aria = String(el.getAttribute && el.getAttribute('aria-label') || '').toLowerCase();
          return txt === '×' || txt === '✕' || cls.includes('close') || aria.includes('close');
        });
        if (close && close.click) { close.click(); return true; }
      }
      return false;
    });
    if (closed) {
      await page.waitForTimeout(700).catch(() => {});
      return true;
    }
  } catch (_) {}

  await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400).catch(() => {});
  return false;
}

async function openCargoTracking(page) {
  const cargoTrackingTabs = [
    page.getByRole('tab', { name: /cargo tracking/i }).last(),
    page.getByRole('button', { name: /cargo tracking/i }).last(),
    page.getByText(/^Cargo Tracking$/i).last(),
    page.locator('text=Cargo Tracking').last(),
  ];

  for (const tab of cargoTrackingTabs) {
    try {
      if (await tab.isVisible({ timeout: 1800 }).catch(() => false)) {
        await tab.click({ timeout: 5000, force: true }).catch(() => {});
        await page.waitForTimeout(900).catch(() => {});
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function searchTracking(page, trackingNumber) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForTimeout(1200 + attempt * 600).catch(() => {});
    await closeFraudNotice(page).catch(() => {});
    await openCargoTracking(page).catch(() => {});

    const selectors = [
    'input[aria-label*="Container No. or B/L No. or Booking No."]',
    'input[placeholder*="Input max" i]',
    'input[placeholder*="Container No." i]',
    'input[aria-label*="Booking No." i]',
    'input[id^="react-aria"]',
  ];

    let input = null;
    for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const candidate = locator.nth(i);
      try {
        await candidate.scrollIntoViewIfNeeded().catch(() => {});
        if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)) {
          input = candidate;
          break;
        }
      } catch (_) {}
    }
    if (input) break;
  }

    if (!input) {
      const visibleInputs = page.locator('input[type="text"]');
    const count = await visibleInputs.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const candidate = visibleInputs.nth(i);
      try {
        if (await candidate.isVisible({ timeout: 1000 }).catch(() => false)) {
          input = candidate;
          break;
        }
      } catch (_) {}
    }
  }

    if (!input) {
      if (attempt === 2) throw new Error('YML tracking input not found');
      continue;
    }

    await input.click({ force: true }).catch(() => {});
    await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await input.press('Backspace').catch(() => {});
    await input.fill('').catch(() => {});
    await page.waitForTimeout(150).catch(() => {});
    await input.type(trackingNumber, { delay: 35 }).catch(async () => {
      await input.fill(trackingNumber);
    });
    await page.waitForTimeout(400).catch(() => {});

    const buttonCandidates = [
    page.getByRole('button', { name: /^search$/i }).last(),
    page.locator('button:has-text("Search")').last(),
  ];

    for (const button of buttonCandidates) {
    try {
      if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
        await button.click({ timeout: 5000, force: true }).catch(() => {});
        await page.waitForTimeout(1200).catch(() => {});
        return;
      }
    } catch (_) {}
  }

    await input.press('Enter').catch(() => {});
    await page.waitForTimeout(1200).catch(() => {});
    return;
  }
}

async function waitForResults(page) {
  const resultCandidates = [
    page.getByText('Basic Information', { exact: true }),
    page.getByText('Routing Schedule', { exact: false }),
    page.getByText('Booking Number', { exact: false }),
    page.getByText('B/L No.', { exact: false }),
  ];

  const notFoundCandidates = [
    page.getByText(/Sorry, we can't identify your input\./i),
    page.getByText(/It's probably caused by typing error\./i),
    page.getByText(/Please check if your BL No\., Booking No\., or Container No\. is correct\./i),
  ];

  for (let i = 0; i < 20; i += 1) {
    for (const c of resultCandidates) {
      try {
        if (await c.isVisible({ timeout: 400 }).catch(() => false)) {
          await page.waitForTimeout(1200).catch(() => {});
          return { notFound: false };
        }
      } catch (_) {}
    }

    for (const c of notFoundCandidates) {
      try {
        if (await c.isVisible({ timeout: 300 }).catch(() => false)) {
          await page.waitForTimeout(300).catch(() => {});
          return { notFound: true };
        }
      } catch (_) {}
    }

    await page.waitForTimeout(800).catch(() => {});
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/Sorry, we can't identify your input\./i.test(bodyText) || /typing error/i.test(bodyText)) {
    return { notFound: true };
  }

  throw new Error('YML result page not found');
}

async function extractPodEta(page) {
  const result = await page.evaluate(() => {
    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const upper = (v) => clean(v).toUpperCase();

    function textNodes(root) {
      return Array.from(root.querySelectorAll('*')).map(el => clean(el.textContent)).filter(Boolean);
    }

    function extractDischarge() {
      // Preferred: Basic Information value cell for Discharge (3rd data cell in YM layout)
      const directCandidates = [
        '[data-key="S.4.0.2"] span',
        '[data-key="S.4.0.2"]',
        '[data-key$=".0.2"] span',
        '[data-key$=".0.2"]'
      ];
      for (const selector of directCandidates) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          const txt = clean(node.textContent);
          if (txt && !/^Discharge$/i.test(txt) && !/^Delivery$/i.test(txt)) return txt;
        }
      }

      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll('tr')).map(tr => Array.from(tr.querySelectorAll('th,td')).map(td => clean(td.textContent)));
        const headerRow = rows.find(r => r.some(t => /^Receipt$/i.test(t)) && r.some(t => /^Loading$/i.test(t)) && r.some(t => /^Discharge$/i.test(t)));
        if (!headerRow) continue;
        const idx = headerRow.findIndex(t => /^Discharge$/i.test(t));
        const headerIndex = rows.indexOf(headerRow);
        const valueRow = rows[headerIndex + 1];
        if (valueRow && valueRow[idx] && !/^Delivery$/i.test(valueRow[idx])) return valueRow[idx];
      }

      const labels = Array.from(document.querySelectorAll('div,span,td,th')).filter(el => /^Discharge$/i.test(clean(el.textContent)));
      for (const label of labels) {
        const row = label.closest('tr') || label.parentElement;
        if (!row) continue;
        const cells = Array.from(row.querySelectorAll('td,th,div,span')).map(el => clean(el.textContent)).filter(Boolean);
        const idx = cells.findIndex(t => /^Discharge$/i.test(t));
        if (idx >= 0 && cells[idx + 1] && !/^Delivery$/i.test(cells[idx + 1])) return cells[idx + 1];
      }
      return '';
    }

    function extractEta(discharge) {
      const dischargeUpper = upper(discharge);
      const dischargeKey = dischargeUpper.split(',')[0] || dischargeUpper;
      const datePattern = /\b\d{4}[/-]\d{2}[/-]\d{2}\s+\d{2}:\d{2}\b/;

      // Prefer routing schedule cards/items that mention the discharge port.
      const candidates = Array.from(document.querySelectorAll('div,li,section')).filter(el => {
        const txt = upper(el.textContent);
        return txt && (txt.includes(dischargeKey) || (dischargeKey.split(' ')[0] && txt.includes(dischargeKey.split(' ')[0])));
      });

      for (const el of candidates) {
        const txt = clean(el.textContent);
        const txtUpper = upper(txt);
        if (!txtUpper.includes(dischargeKey.split(' ')[0] || dischargeKey)) continue;
        if (/TO BE ADVISE/i.test(txt)) return 'To be Advise';
        const badge = Array.from(el.querySelectorAll('span,div')).some(n => /Actual/i.test(clean(n.textContent)));
        const match = txt.match(datePattern);
        if (badge && match) return match[0];
      }

      // Fallback: any visible Actual badge in Routing Schedule, take nearest datetime.
      const actualNodes = Array.from(document.querySelectorAll('span,div')).filter(el => /Actual/i.test(clean(el.textContent)));
      for (const node of actualNodes) {
        const scope = node.closest('div,li,section');
        const txt = clean(scope ? scope.textContent : node.textContent);
        const match = txt.match(datePattern);
        if (match) return match[0];
      }

      // Fallback: if any matching discharge block says To be Advise.
      const bodyText = clean(document.body.textContent);
      if (/To be Advise/i.test(bodyText) && dischargeKey) {
        return 'To be Advise';
      }

      return '';
    }

    const pod = extractDischarge();
    const eta = extractEta(pod);
    return { pod, eta };
  });

  return {
    pod: cleanValue(result.pod),
    eta: cleanValue(result.eta),
  };
}

function cleanValue(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

module.exports = trackYML;

if (require.main === module) {
  const trackingNumber = process.argv[2] || 'I490584631';
  trackYML(trackingNumber).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'success' ? 0 : 1);
  });
}
