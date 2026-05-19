const path = require('path');
const { readInputRowsFromFile, writeResultFiles } = require('./lib/tabular_io');
const trackMSC = require('./carriers/msc');
const trackEMC = require('./carriers/emc');
const trackONE = require('./carriers/one');
const trackSIT = require('./carriers/sit');
const trackYML = require('./carriers/yml');
const trackKMT = require('./carriers/kmt');
const trackIAL = require('./carriers/ial');
const trackMSK = require('./carriers/msk');
const trackWHL = require('./carriers/whl');
const trackCMA = require('./carriers/cma');
const trackRCL = require('./carriers/rcl');

const CARRIER_MAP = {
  MSC: trackMSC,
  EMC: trackEMC,
  EVERGREEN: trackEMC,
  ONE: trackONE,
  SIT: trackSIT,
  SITC: trackSIT,
  YML: trackYML,
  YANGMING: trackYML,
  KMT: trackKMT,
  KMTC: trackKMT,
  IAL: trackIAL,
  MSK: trackMSK,
  MAERSK: trackMSK,
  WHL: trackWHL,
  WANHAI: trackWHL,
  'WAN HAI': trackWHL,
  CMA: trackCMA,
  'CMA CGM': trackCMA,
  'CMA-CGM': trackCMA,
  CMACGM: trackCMA,
  RCL: trackRCL,
  'RCL GROUP': trackRCL,
  'REGIONAL CONTAINER LINES': trackRCL,
};

async function main() {
  const inputPath = path.resolve(process.argv[2] || process.env.TRACKING_INPUT_PATH || 'data/input.tsv');
  const outputBasePath = path.resolve(process.argv[3] || process.env.TRACKING_OUTPUT_BASE || 'data/results/latest');

  const { rows, columnsFound, delimiter } = readInputRowsFromFile(inputPath, {
    ignoredCarriers: ['VESSEL', '0'],
  });

  console.log(`Input file     : ${inputPath}`);
  console.log(`Input delimiter: ${delimiter === '\t' ? 'TAB' : delimiter}`);
  console.log(`Output base    : ${outputBasePath}`);
  console.log(`Rows to track  : ${rows.length}`);
  console.log(`Columns found  : ${JSON.stringify(columnsFound)}`);

  const outputRows = [];
  for (const row of rows) {
    console.log(`Row ${row.sourceRow}: ${row.trackingNumber} / ${row.carrier}`);

    let result;
    if (!row.trackingNumber) {
      result = { pod: '', eta: '', error: 'Missing TRACKING NUMBER' };
    } else if (!row.carrier) {
      result = { pod: '', eta: '', error: 'Missing CARRIER' };
    } else {
      const handler = CARRIER_MAP[row.carrier];
      if (!handler) {
        result = { pod: '', eta: '', error: `Carrier not supported yet: ${row.carrier}` };
      } else {
        try {
          result = await handler(row.trackingNumber, { headless: true, slowMo: process.env.CI ? 0 : undefined });
        } catch (error) {
          result = { pod: '', eta: '', error: error && error.message ? error.message : String(error) };
        }
      }
    }

    outputRows.push({
      ...row,
      pod: result.pod || '',
      eta: result.eta || '',
      error: result.error || '',
      lastChecked: formatGmt7Now(),
    });
  }

  const files = writeResultFiles(outputBasePath, outputRows);
  console.log(`Done. Output updated: ${JSON.stringify(files, null, 2)}`);
}

function formatGmt7Now() {
  const now = new Date();
  const gmt7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return gmt7.toISOString().replace('T', ' ').slice(0, 19);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
