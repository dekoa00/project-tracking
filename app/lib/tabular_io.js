const fs = require('fs');
const path = require('path');

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

function normalizeHeader(value) {
  return String(value == null ? '' : value)
    .replace(/^\uFEFF/, '')
    .trim()
    .toUpperCase()
    .replace(/[\s_\-/]+/g, ' ')
    .replace(/\.+$/g, '')
    .trim();
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeCarrier(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeTrackingNumber(value) {
  const raw = normalizeText(value);
  if (!raw) return '';

  // Undo Excel/scientific-notation-ish values if someone pasted from a bad export.
  // Example: 2.35502E+11 -> 235502000000. This is only a fallback; text format is still best.
  if (/^\d+(?:\.\d+)?e\+?\d+$/i.test(raw)) {
    const num = Number(raw);
    if (Number.isFinite(num)) return String(Math.trunc(num));
  }

  return raw;
}

function splitLine(line, delimiter) {
  // Keep parser intentionally simple because the input is usually copy/paste from Excel/Sheets.
  // If values can contain delimiters inside quotes later, swap this for a CSV parser package.
  return line.split(delimiter).map(cell => cell.trim().replace(/^"|"$/g, ''));
}

function detectDelimiter(firstNonEmptyLine) {
  if (firstNonEmptyLine.includes('\t')) return '\t';
  if (firstNonEmptyLine.includes(',')) return ',';
  if (firstNonEmptyLine.includes(';')) return ';';
  return '\t';
}

function findColumn(headerMap, candidates) {
  for (const candidate of candidates) {
    const key = normalizeHeader(candidate);
    if (headerMap.has(key)) return headerMap.get(key);
  }
  return null;
}

function buildKey(trackingNumber, carrier) {
  return `${normalizeTrackingNumber(trackingNumber)}__${normalizeCarrier(carrier)}`;
}

function readInputRowsFromText(text, options = {}) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0);

  if (!lines.length) return { rows: [], columnsFound: {}, delimiter: '\t' };

  const delimiter = options.delimiter || detectDelimiter(lines[0]);
  const header = splitLine(lines[0], delimiter);
  const headerMap = new Map();
  header.forEach((value, index) => headerMap.set(normalizeHeader(value), index));

  const bkgCol = findColumn(headerMap, ['BKG', 'BOOKING', 'BOOKING NO', 'BOOKING NUMBER']);
  const blNoCol = findColumn(headerMap, ['BL NO.', 'BL NO', 'B/L NO', 'BILL OF LADING', 'BL']);
  const trackingCol = findColumn(headerMap, ['TRACKING NUMBER', 'TRACKING NO', 'TRACKING', 'TRACKING_NUMBER']);
  const carrierCol = findColumn(headerMap, ['CARRIER', 'LINE', 'CARRIER CODE']);

  if (trackingCol == null) throw new Error('Cannot find TRACKING NUMBER column in TSV/CSV input');
  if (carrierCol == null) throw new Error('Cannot find CARRIER column in TSV/CSV input');

  const ignoredCarriers = new Set((options.ignoredCarriers || ['VESSEL', '0']).map(normalizeCarrier).filter(Boolean));
  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitLine(lines[i], delimiter);
    const bkg = bkgCol == null ? '' : normalizeText(cells[bkgCol]);
    const blNo = blNoCol == null ? '' : normalizeText(cells[blNoCol]);
    const trackingNumber = normalizeTrackingNumber(cells[trackingCol]);
    const carrier = normalizeCarrier(cells[carrierCol]);

    if (!bkg && !blNo && !trackingNumber && !carrier) continue;
    if (options.skipMissingTracking !== false && !trackingNumber) continue;
    if (options.skipMissingCarrier !== false && !carrier) continue;
    if (ignoredCarriers.has(carrier)) continue;

    rows.push({
      sourceRow: i + 1,
      key: buildKey(trackingNumber, carrier),
      bkg,
      blNo,
      trackingNumber,
      carrier,
    });
  }

  return {
    rows,
    delimiter,
    columnsFound: { bkgCol, blNoCol, trackingCol, carrierCol },
  };
}

function readInputRowsFromFile(inputPath, options = {}) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`Input TSV/CSV not found: ${resolved}`);
  const text = fs.readFileSync(resolved, 'utf8');
  return { inputPath: resolved, ...readInputRowsFromText(text, options) };
}

function escapeTsv(value) {
  return String(value == null ? '' : value).replace(/\r?\n/g, ' ').trim();
}

function escapeCsv(value) {
  const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ').trim();
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function rowToOutputArray(row) {
  return [
    row.key || buildKey(row.trackingNumber, row.carrier),
    row.bkg || '',
    row.blNo || '',
    row.trackingNumber || '',
    row.carrier || '',
    row.pod || '',
    row.eta || '',
    row.error || '',
    row.lastChecked || '',
  ];
}

function writeResultFiles(outputBasePath, rows) {
  const base = path.resolve(outputBasePath);
  fs.mkdirSync(path.dirname(base), { recursive: true });

  const serializable = rows.map(row => ({
    key: row.key || buildKey(row.trackingNumber, row.carrier),
    bkg: row.bkg || '',
    blNo: row.blNo || '',
    trackingNumber: row.trackingNumber || '',
    carrier: row.carrier || '',
    pod: row.pod || '',
    eta: row.eta || '',
    error: row.error || '',
    lastChecked: row.lastChecked || '',
  }));

  fs.writeFileSync(`${base}.json`, JSON.stringify(serializable, null, 2), 'utf8');

  const tsvLines = [OUTPUT_HEADERS.join('\t')];
  for (const row of rows) tsvLines.push(rowToOutputArray(row).map(escapeTsv).join('\t'));
  fs.writeFileSync(`${base}.tsv`, `${tsvLines.join('\n')}\n`, 'utf8');

  const csvLines = [OUTPUT_HEADERS.map(escapeCsv).join(',')];
  for (const row of rows) csvLines.push(rowToOutputArray(row).map(escapeCsv).join(','));
  fs.writeFileSync(`${base}.csv`, `${csvLines.join('\n')}\n`, 'utf8');

  return {
    json: `${base}.json`,
    tsv: `${base}.tsv`,
    csv: `${base}.csv`,
  };
}

module.exports = {
  readInputRowsFromFile,
  readInputRowsFromText,
  writeResultFiles,
  buildKey,
};
