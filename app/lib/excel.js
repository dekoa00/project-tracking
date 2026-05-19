const path = require('path');
const XLSX = require('xlsx');

function readWorksheetRows(filePath, sheetName) {
  const workbook = XLSX.readFile(filePath);
  const targetSheetName = sheetName || workbook.SheetNames[0];
  const sheet = workbook.Sheets[targetSheetName];
  if (!sheet) throw new Error(`Sheet not found: ${targetSheetName}`);

  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:D1');
  const rows = [];

  for (let rowIndex = 1; rowIndex <= range.e.r; rowIndex++) {
    const trackingNumber = getCellValue(sheet, rowIndex, 0);
    const carrier = getCellValue(sheet, rowIndex, 1);

    rows.push({
      rowIndex,
      trackingNumber: normalizeText(trackingNumber),
      carrier: normalizeText(carrier).toUpperCase(),
    });
  }

  return { workbook, sheet, sheetName: targetSheetName, rows };
}

function writeResult(sheet, rowIndex, result) {
  setCellValue(sheet, rowIndex, 2, result.pod || '');
  setCellValue(sheet, rowIndex, 3, result.eta || '');
  setCellValue(sheet, rowIndex, 4, result.error || '');
}

function saveWorkbook(workbook, filePath) {
  try {
    XLSX.writeFile(workbook, filePath);
    return filePath;
  } catch (error) {
    if (error && (error.code === 'EBUSY' || error.code === 'EPERM')) {
      const parsed = path.parse(filePath);
      const fallbackPath = path.join(parsed.dir, `${parsed.name}-output${parsed.ext || '.xlsx'}`);
      XLSX.writeFile(workbook, fallbackPath);
      return fallbackPath;
    }
    throw error;
  }
}

function getCellValue(sheet, rowIndex, columnIndex) {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
  return sheet[address] ? sheet[address].v : '';
}

function setCellValue(sheet, rowIndex, columnIndex, value) {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
  sheet[address] = { t: 's', v: value == null ? '' : String(value) };

  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:E1');
  if (rowIndex > range.e.r) range.e.r = rowIndex;
  if (columnIndex > range.e.c) range.e.c = columnIndex;
  sheet['!ref'] = XLSX.utils.encode_range(range);
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

module.exports = {
  readWorksheetRows,
  writeResult,
  saveWorkbook,
};
