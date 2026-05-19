const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const OUTPUT_HEADERS = [
  'KEY',
  'BKG',
  'BL NO.',
  'TRACKING NUMBER',
  'CARRIER',
  'POD',
  'ETA',
  'ERROR',
  'LAST CHECKED'
];

function loadConfig(configPath) {
  const resolved = path.resolve(configPath || path.join(__dirname, '..', 'config.json'));
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing config file: ${resolved}. Copy config.example.json to config.json first.`);
  }
  const rawConfig = fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '');
  const config = JSON.parse(rawConfig);
  if (!config.inputWorkbookPath) throw new Error('Missing config.inputWorkbookPath');
  if (!config.outputWorkbookPath) throw new Error('Missing config.outputWorkbookPath');
  return config;
}

function readInputRows(config) {
  const inputPath = resolveConfiguredPath(config.inputWorkbookPath);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input workbook not found: ${inputPath}`);
  }

  const workbook = XLSX.readFile(inputPath, { cellDates: true });
  const sheetName = config.inputSheetName || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Input sheet not found: ${sheetName}`);

  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const headerRowIndex = Math.max(0, Number(config.startRow || 2) - 2);
  const dataStartIndex = Math.max(1, Number(config.startRow || 2) - 1);
  const headerMap = buildHeaderMap(sheet, range, headerRowIndex);

  const columns = config.columns || {};
  const bkgCol = findColumn(headerMap, columns.bkg || ['BKG']);
  const blNoCol = findColumn(headerMap, columns.blNo || ['BL NO.', 'BL NO']);
  const trackingCol = findColumn(headerMap, columns.trackingNumber || ['TRACKING NUMBER']);
  const carrierCol = findColumn(headerMap, columns.carrier || ['CARRIER']);

  if (trackingCol == null) throw new Error('Cannot find TRACKING NUMBER column in input workbook');
  if (carrierCol == null) throw new Error('Cannot find CARRIER column in input workbook');

  const rows = [];
  for (let rowIndex = dataStartIndex; rowIndex <= range.e.r; rowIndex++) {
    const bkg = bkgCol == null ? '' : normalizeInputText(getCellValue(sheet, rowIndex, bkgCol));
    const blNo = blNoCol == null ? '' : normalizeInputText(getCellValue(sheet, rowIndex, blNoCol));
    const trackingNumber = normalizeTrackingNumber(getCellValue(sheet, rowIndex, trackingCol));
    const carrier = normalizeCarrier(getCellValue(sheet, rowIndex, carrierCol));

    if (!bkg && !blNo && !trackingNumber && !carrier) continue;
    if (config.skipMissingTracking !== false && !trackingNumber) continue;
    if (config.skipMissingCarrier !== false && !carrier) continue;

    const ignoredCarriers = new Set((config.ignoredCarriers || ['VESSEL']).map(value => normalizeCarrier(value)).filter(Boolean));
    if (ignoredCarriers.has(carrier)) continue;

    rows.push({
      sourceRow: rowIndex + 1,
      key: buildKey(trackingNumber, carrier),
      bkg,
      blNo,
      trackingNumber,
      carrier,
    });
  }

  return { inputPath, sheetName, rows, columnsFound: { bkgCol, blNoCol, trackingCol, carrierCol } };
}

function writeOutputWorkbook(outputPath, rows, sheetName) {
  const workbook = XLSX.utils.book_new();
  const data = [OUTPUT_HEADERS];

  for (const row of rows) {
    data.push([
      row.key || buildKey(row.trackingNumber, row.carrier),
      row.bkg || '',
      row.blNo || '',
      row.trackingNumber || '',
      row.carrier || '',
      row.pod || '',
      row.eta || '',
      row.error || '',
      row.lastChecked || '',
    ]);
  }

  const sheet = XLSX.utils.aoa_to_sheet(data);

  // Normalize ETA cells into real Excel date numbers when possible.
  // Carrier time components are intentionally dropped so ETA stays date-only.
  // Column G = ETA, data rows start at Excel row 2.
  for (let i = 0; i < rows.length; i++) {
    const parsedEta = parseEtaToExcelSerial(rows[i].eta);
    if (!parsedEta) continue;

    const address = XLSX.utils.encode_cell({ r: i + 1, c: 6 });
    sheet[address] = {
      t: 'n',
      // ETA should be date-only. Drop any carrier time component so Excel shows only MMM. DD, YYYY.
      v: Math.floor(parsedEta.serial),
      z: 'mmm. dd, yyyy',
    };
  }

  // Format LAST CHECKED as real Excel date-time too. Column I = LAST CHECKED.
  for (let i = 0; i < rows.length; i++) {
    const parsedLastChecked = parseEtaToExcelSerial(rows[i].lastChecked);
    if (!parsedLastChecked) continue;

    const address = XLSX.utils.encode_cell({ r: i + 1, c: 8 });
    sheet[address] = {
      t: 'n',
      v: parsedLastChecked.serial,
      z: 'dd/mm/yyyy hh:mm',
    };
  }

  sheet['!cols'] = [
    { wch: 28 },
    { wch: 18 },
    { wch: 20 },
    { wch: 22 },
    { wch: 12 },
    { wch: 24 },
    { wch: 18 },
    { wch: 42 },
    { wch: 22 },
  ];

  XLSX.utils.book_append_sheet(workbook, sheet, sheetName || 'Tracking_Result');
  const resolvedOutputPath = resolveConfiguredPath(outputPath);
  ensureDir(path.dirname(resolvedOutputPath));
  safeWriteWorkbook(workbook, resolvedOutputPath);
}

function parseEtaToExcelSerial(value) {
  const raw = normalizeText(value);
  if (!raw) return null;

  const lower = raw.toLowerCase();
  if (
    lower.includes('advise') ||
    lower.includes('tba') ||
    lower.includes('n/a') ||
    lower.includes('na') ||
    lower.includes('nil')
  ) {
    return null;
  }

  // Keep only the date-looking portion when carriers include extra text.
  const text = raw.replace(/\s+/g, ' ').trim();

  let match;

  // YYYY/MM/DD HH:mm, YYYY-MM-DD HH:mm, YYYY.MM.DD HH:mm
  match = text.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?)?/);
  if (match) {
    return makeExcelSerial(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4] || 0),
      Number(match[5] || 0)
    );
  }

  // DD/MM/YYYY HH:mm, DD-MM-YYYY HH:mm, DD.MM.YYYY HH:mm
  match = text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?)?/);
  if (match) {
    return makeExcelSerial(
      Number(match[3]),
      Number(match[2]),
      Number(match[1]),
      Number(match[4] || 0),
      Number(match[5] || 0)
    );
  }

  // CMA style: Fri.06-MAR-2026 10:00 AM, 06-MAR-2026, 06 Mar 2026 10:00
  match = text.match(/(?:[A-Za-z]{3,9}\.?\s*)?(\d{1,2})[\s\-/]+([A-Za-z]{3,9})[\s\-/]+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?)?/i);
  if (match) {
    const month = monthNameToNumber(match[2]);
    if (month) {
      let hour = Number(match[4] || 0);
      const minute = Number(match[5] || 0);
      const ampm = String(match[6] || '').toUpperCase();
      if (ampm === 'PM' && hour < 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;
      return makeExcelSerial(
        Number(match[3]),
        month,
        Number(match[1]),
        hour,
        minute
      );
    }
  }

  // APR-06-2026, Apr 06 2026, MAY-10-2026 HH:mm
  match = text.match(/([A-Za-z]{3,9})[\s\-/]+(\d{1,2})(?:,)?[\s\-/]+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (match) {
    const month = monthNameToNumber(match[1]);
    if (month) {
      return makeExcelSerial(
        Number(match[3]),
        month,
        Number(match[2]),
        Number(match[4] || 0),
        Number(match[5] || 0)
      );
    }
  }

  return null;
}

function makeExcelSerial(year, month, day, hour = 0, minute = 0) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const utc = Date.UTC(year, month - 1, day, hour || 0, minute || 0, 0);
  const date = new Date(utc);

  // Validate the date was not auto-rolled, e.g. 31/02/2026.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    serial: utc / 86400000 + 25569,
    hasTime: Boolean((hour || 0) || (minute || 0)),
  };
}

function monthNameToNumber(value) {
  const key = normalizeText(value).slice(0, 3).toUpperCase();
  return {
    JAN: 1,
    FEB: 2,
    MAR: 3,
    APR: 4,
    MAY: 5,
    JUN: 6,
    JUL: 7,
    AUG: 8,
    SEP: 9,
    OCT: 10,
    NOV: 11,
    DEC: 12,
  }[key] || null;
}

function resolveConfiguredPath(value) {
  let raw = String(value == null ? '' : value).trim();
  if (!raw) return raw;

  const oneDriveRoot = process.env.OneDrive || process.env.OneDriveCommercial || process.env.OneDriveConsumer || '';
  if (oneDriveRoot) {
    raw = raw.replace(/%OneDrive%/gi, oneDriveRoot);
    raw = raw.replace(/\$env:OneDrive/gi, oneDriveRoot);
  }

  raw = raw.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
  return path.resolve(raw);
}

function safeWriteWorkbook(workbook, outputPath) {
  const resolved = path.resolve(outputPath);
  const tmp = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${Date.now()}.tmp.xlsx`);
  XLSX.writeFile(workbook, tmp);
  try {
    fs.copyFileSync(tmp, resolved);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function buildHeaderMap(sheet, range, headerRowIndex) {
  const map = new Map();
  for (let col = range.s.c; col <= range.e.c; col++) {
    const header = normalizeHeader(getCellValue(sheet, headerRowIndex, col));
    if (header) map.set(header, col);
  }
  return map;
}

function findColumn(headerMap, names) {
  for (const name of [].concat(names || [])) {
    const normalized = normalizeHeader(name);
    if (headerMap.has(normalized)) return headerMap.get(normalized);
  }
  return null;
}

function getCellValue(sheet, rowIndex, columnIndex) {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
  const cell = sheet[address];
  if (!cell) return '';

  // Important: prefer the raw value instead of cell.w.
  // Excel often formats long numeric shipment numbers as 2.35502E+11 in cell.w.
  // Reading cell.v lets us recover values like 235502026291 when the file was saved as numeric.
  if (cell.v != null && cell.v !== '') return cell.v;
  if (cell.w != null) return cell.w;
  return '';
}

function buildKey(trackingNumber, carrier) {
  const tracking = normalizeText(trackingNumber);
  const line = normalizeText(carrier).toUpperCase();
  return tracking && line ? `${tracking}|${line}` : '';
}

function normalizeHeader(value) {
  return normalizeText(value).toUpperCase().replace(/\s+/g, ' ').replace(/[:：]/g, '').trim();
}

function normalizeInputText(value) {
  const text = normalizeText(value);
  return isBlankLike(text) ? '' : text;
}

function normalizeTrackingNumber(value) {
  const text = normalizeInputText(value);
  if (!text) return '';
  return text.replace(/\s+/g, '');
}

function normalizeCarrier(value) {
  const text = normalizeInputText(value).toUpperCase();
  return text;
}

function isBlankLike(value) {
  const text = String(value == null ? '' : value).trim();
  return text === '' || text === '0' || text === '-' || text.toUpperCase() === 'N/A';
}

function normalizeText(value) {
  if (value == null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    if (Number.isInteger(value)) return value.toFixed(0);
    return String(value);
  }
  return String(value).trim();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  loadConfig,
  readInputRows,
  writeOutputWorkbook,
};
