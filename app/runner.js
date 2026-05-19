const path = require('path');
const { loadConfig, readInputRows, writeOutputWorkbook } = require('./lib/excel_server');
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
  ONE: trackONE,
  SIT: trackSIT,
  YML: trackYML,
  KMT: trackKMT,
  IAL: trackIAL,
  MSK: trackMSK,
  WHL: trackWHL,
  CMA: trackCMA,
  'CMA CGM': trackCMA,
  'CMA-CGM': trackCMA,
  CMACGM: trackCMA,
  RCL: trackRCL,
  'RCL GROUP': trackRCL,
  'REGIONAL CONTAINER LINES': trackRCL,
};

async function main() {
  const configPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'config.json');
  const config = loadConfig(configPath);
  const { inputPath, sheetName, rows, columnsFound } = readInputRows(config);

  console.log(`Input workbook : ${inputPath}`);
  console.log(`Input sheet    : ${sheetName}`);
  console.log(`Output workbook: ${path.resolve(config.outputWorkbookPath)}`);
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
          result = await handler(row.trackingNumber);
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

  writeOutputWorkbook(config.outputWorkbookPath, outputRows, config.outputSheetName);
  console.log(`Done. Output updated: ${path.resolve(config.outputWorkbookPath)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});


function formatGmt7Now() {
  const now = new Date();
  const gmt7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return gmt7.toISOString().replace('T', ' ').slice(0, 19);
}
