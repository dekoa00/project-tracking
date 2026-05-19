param(
  [Parameter(Mandatory=$true)]
  [string]$RawWorkbookPath,
  [Parameter(Mandatory=$true)]
  [string]$ResultWorkbookPath,
  [string]$ResultSheetName = 'Tracking_Result',
  [string]$MirrorSheetName = '3. result',
  [switch]$Visible
)

$ErrorActionPreference = 'Stop'

function Log($msg) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-Host "[$ts] $msg"
}

function Release-ComObjectSafe($obj) {
  if ($null -ne $obj) {
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($obj) | Out-Null } catch {}
  }
}

$rawPath = [System.IO.Path]::GetFullPath($RawWorkbookPath)
$resultPath = [System.IO.Path]::GetFullPath($ResultWorkbookPath)

if (!(Test-Path -LiteralPath $rawPath)) { throw "Raw workbook not found: $rawPath" }
if (!(Test-Path -LiteralPath $resultPath)) { throw "Result workbook not found: $resultPath" }

$excel = $null
$rawWb = $null
$resultWb = $null
$rawWs = $null
$resultWs = $null

try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = [bool]$Visible
  $excel.DisplayAlerts = $false
  $excel.AskToUpdateLinks = $false
  $excel.EnableEvents = $false
  try { $excel.AutomationSecurity = 3 } catch {}
  try { $excel.Calculation = -4105 } catch {} # xlCalculationAutomatic

  Log "Opening result workbook: $resultPath"
  $resultWb = $excel.Workbooks.Open($resultPath, 0, $true)
  try { $resultWs = $resultWb.Worksheets.Item($ResultSheetName) } catch { throw "Result sheet not found: $ResultSheetName" }

  Log "Opening raw workbook for mirror: $rawPath"
  $rawWb = $excel.Workbooks.Open($rawPath, 0, $false)
  if ($rawWb.ReadOnly) {
    throw "Raw workbook opened read-only. Close tracking_raw.xlsx in Excel/Excel Online sync and run again: $rawPath"
  }

  try {
    $rawWs = $rawWb.Worksheets.Item($MirrorSheetName)
  } catch {
    Log "Mirror sheet not found. Creating: $MirrorSheetName"
    $rawWs = $rawWb.Worksheets.Add()
    $rawWs.Name = $MirrorSheetName
  }

  $used = $resultWs.UsedRange
  $rows = $used.Rows.Count
  $cols = $used.Columns.Count
  Log "Copying result used range: ${rows} rows x ${cols} cols"

  # Clear only the mirror sheet. This preserves all other sheets, Power Query, workbook links, and OneDrive metadata.
  $rawWs.Cells.Clear()

  $sourceRange = $resultWs.Range($resultWs.Cells.Item(1,1), $resultWs.Cells.Item($rows,$cols))
  $targetRange = $rawWs.Range($rawWs.Cells.Item(1,1), $rawWs.Cells.Item($rows,$cols))

  # Copy values first, then number formats. This keeps ETA as real Excel dates.
  $targetRange.Value2 = $sourceRange.Value2
  $targetRange.NumberFormat = $sourceRange.NumberFormat

  # Header style + widths for readability.
  try { $rawWs.Rows.Item(1).Font.Bold = $true } catch {}
  try {
    for ($c = 1; $c -le $cols; $c++) {
      $rawWs.Columns.Item($c).ColumnWidth = $resultWs.Columns.Item($c).ColumnWidth
    }
  } catch {}

  try { $rawWb.Save() } catch { throw "Could not save raw workbook after mirror: $($_.Exception.Message)" }
  Log "Mirror completed: $MirrorSheetName in tracking_raw.xlsx"
}
finally {
  if ($null -ne $resultWb) { try { $resultWb.Close($false) } catch {} }
  if ($null -ne $rawWb) { try { $rawWb.Close($true) } catch {} }
  if ($null -ne $excel) { try { $excel.Quit() } catch {} }
  Release-ComObjectSafe $sourceRange
  Release-ComObjectSafe $targetRange
  Release-ComObjectSafe $used
  Release-ComObjectSafe $resultWs
  Release-ComObjectSafe $rawWs
  Release-ComObjectSafe $resultWb
  Release-ComObjectSafe $rawWb
  Release-ComObjectSafe $excel
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
