param(
  [Parameter(Mandatory=$true)]
  [string]$FolderPath,
  [string]$MarkerName = 'last_sync_trigger.txt'
)

$ErrorActionPreference = 'Stop'

function Log($msg) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-Host "[$ts] $msg"
}

$folder = [System.IO.Path]::GetFullPath($FolderPath)
if (!(Test-Path -LiteralPath $folder)) { throw "Folder not found: $folder" }

$marker = Join-Path $folder $MarkerName
$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Set-Content -LiteralPath $marker -Value "Last bot run: $now" -Encoding UTF8

# Touch the two workbook files after every COM close. This is intentionally tiny: it only updates timestamps,
# so OneDrive notices the final saved files without recursively toggling Files On-Demand attributes.
foreach ($name in @('tracking_raw.xlsx', 'tracking_result.xlsx')) {
  $path = Join-Path $folder $name
  if (Test-Path -LiteralPath $path) {
    try {
      (Get-Item -LiteralPath $path).LastWriteTime = Get-Date
      Log "Touched: $name"
    } catch {
      Log "WARN: Could not touch $name - $($_.Exception.Message)"
    }
  }
}

Log "OneDrive rescan marker updated: $marker"
