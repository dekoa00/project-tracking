param(
  [string]$ConfigPath = '.\config.json',
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (!$scriptDir) { $scriptDir = (Get-Location).Path }
$root = Split-Path -Parent $scriptDir
Set-Location $root

function Log($msg) {
  if ($Silent) { return }
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-Host "[$ts] $msg"
}

function Get-OneDriveRoot() {
  if ($env:OneDrive -and (Test-Path -LiteralPath $env:OneDrive)) { return $env:OneDrive }
  if ($env:OneDriveCommercial -and (Test-Path -LiteralPath $env:OneDriveCommercial)) { return $env:OneDriveCommercial }
  if ($env:OneDriveConsumer -and (Test-Path -LiteralPath $env:OneDriveConsumer)) { return $env:OneDriveConsumer }
  return $null
}

function Resolve-ProjectPath($value) {
  $raw = [string]$value
  if ([string]::IsNullOrWhiteSpace($raw)) { return $raw }

  $oneDriveRoot = Get-OneDriveRoot
  if ($oneDriveRoot) {
    $raw = $raw.Replace('%OneDrive%', $oneDriveRoot)
    $raw = $raw.Replace('$env:OneDrive', $oneDriveRoot)
  }

  $raw = [System.Environment]::ExpandEnvironmentVariables($raw)

  if ([System.IO.Path]::IsPathRooted($raw)) { return [System.IO.Path]::GetFullPath($raw) }
  return [System.IO.Path]::GetFullPath((Join-Path $root $raw))
}

function Assert-FileUnlocked($path, $label) {
  if (!(Test-Path -LiteralPath $path)) { return }
  $stream = $null
  try {
    $stream = [System.IO.File]::Open($path, 'Open', 'ReadWrite', 'None')
  } catch {
    throw "$label is locked/open. Close it in Excel, wait OneDrive sync, then rerun: $path"
  } finally {
    if ($null -ne $stream) { $stream.Close(); $stream.Dispose() }
  }
}

function Copy-Over($src, $dst) {
  $dir = Split-Path -Parent $dst
  if (!(Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Copy-Item -LiteralPath $src -Destination $dst -Force
  try { (Get-Item -LiteralPath $dst).LastWriteTime = Get-Date } catch {}
}

$configFull = Resolve-ProjectPath $ConfigPath
if (!(Test-Path -LiteralPath $configFull)) { throw "Missing config file: $configFull" }
$config = Get-Content -Raw -LiteralPath $configFull | ConvertFrom-Json

$rawPath = Resolve-ProjectPath $config.inputWorkbookPath
$resultPath = Resolve-ProjectPath $config.outputWorkbookPath
$outputSheet = if ($config.outputSheetName) { [string]$config.outputSheetName } else { 'Tracking_Result' }
$mirrorSheet = if ($config.mirrorOutputSheetName) { [string]$config.mirrorOutputSheetName } else { '3. result' }
$inputSheet = if ($config.inputSheetName) { [string]$config.inputSheetName } else { '1. raw' }
$shouldMirror = $true
if ($null -ne $config.mirrorOutputToInputWorkbook) { $shouldMirror = [bool]$config.mirrorOutputToInputWorkbook }

if (!(Test-Path -LiteralPath $rawPath)) {
  throw "Input workbook not found: $rawPath. Expected OneDrive file: tracking_raw.xlsx. Edit config.inputWorkbookPath if your OneDrive path is different."
}

# Abort early if Excel/OneDrive already has the final files locked. This prevents merge-conflict copies.
Assert-FileUnlocked $rawPath 'tracking_raw.xlsx'
Assert-FileUnlocked $resultPath 'tracking_result.xlsx'

$workBase = Join-Path $env:TEMP ('shipment_tracking_work_' + (Get-Date -Format 'yyyyMMdd_HHmmss'))
New-Item -ItemType Directory -Path $workBase -Force | Out-Null
$workRaw = Join-Path $workBase 'tracking_raw.work.xlsx'
$workResult = Join-Path $workBase 'tracking_result.work.xlsx'
$workConfig = Join-Path $workBase 'config.work.json'

try {
  Log "Creating local staging copy outside OneDrive: $workBase"
  Copy-Item -LiteralPath $rawPath -Destination $workRaw -Force

  # Build temp config so the bot reads/writes only staging files while running.
  # Important: no workbook refresh here. Input is manually maintained in sheet '1. raw'.
  $config.inputWorkbookPath = $workRaw
  $config.outputWorkbookPath = $workResult
  $config.inputSheetName = $inputSheet
  $json = $config | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($workConfig, $json, [System.Text.UTF8Encoding]::new($false))

  Log "STEP 1: Run shipment tracking bot from staged tracking_raw.xlsx / $inputSheet"
  $autoSetupPython = $false
  if ($null -ne $config.autoSetupPythonCarriers) { $autoSetupPython = [bool]$config.autoSetupPythonCarriers }
  if ($autoSetupPython -and !(Test-Path -LiteralPath (Join-Path $root '.venv-cma\Scripts\python.exe'))) {
    Log 'Python carrier env not found. Running setup-python-carriers.bat for CMA/RCL...'
    & cmd /c "`"$(Join-Path $root 'setup-python-carriers.bat')`""
    if ($LASTEXITCODE -ne 0) {
      $nonFatalPythonSetup = $true
      if ($null -ne $config.pythonSetupNonFatal) { $nonFatalPythonSetup = [bool]$config.pythonSetupNonFatal }
      if ($nonFatalPythonSetup) {
        Log 'WARNING: Python carrier setup failed. The run will continue; CMA/RCL rows may show env-missing errors until setup-python-carriers.bat succeeds.'
      } else {
        throw 'setup-python-carriers.bat failed.'
      }
    }
  }

  & node (Join-Path $root 'app\runner.js') $workConfig
  if ($LASTEXITCODE -ne 0) { throw 'Bot failed.' }
  if (!(Test-Path -LiteralPath $workResult)) { throw "Bot did not create staged result workbook: $workResult" }

  if ($shouldMirror) {
    Log "STEP 2: Mirror staged result into staged tracking_raw.xlsx / $mirrorSheet"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\mirror_result_to_raw.ps1') -RawWorkbookPath $workRaw -ResultWorkbookPath $workResult -ResultSheetName $outputSheet -MirrorSheetName $mirrorSheet
    if ($LASTEXITCODE -ne 0) { throw 'Mirror into staged tracking_raw.xlsx failed.' }
  } else {
    Log 'STEP 2: Mirror skipped by config.mirrorOutputToInputWorkbook=false'
  }

  Log 'STEP 3: Final lock check before replacing OneDrive files'
  Assert-FileUnlocked $rawPath 'tracking_raw.xlsx'
  Assert-FileUnlocked $resultPath 'tracking_result.xlsx'

  Log 'STEP 4: Replace OneDrive files once, after all Excel COM work is closed'
  Copy-Over $workResult $resultPath
  if ($shouldMirror) { Copy-Over $workRaw $rawPath }

  $trackingDir = Split-Path -Parent $rawPath
  $trigger = Join-Path $trackingDir 'last_sync_trigger.txt'
  [System.IO.File]::WriteAllText($trigger, ("Last Project Tracking run: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')), [System.Text.UTF8Encoding]::new($false))

  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\force_onedrive_rescan.ps1') -FolderPath $trackingDir
  } catch {
    Log "OneDrive rescan nudge skipped: $($_.Exception.Message)"
  }

  Log 'DONE: staged run completed. OneDrive now only has final file replacements to upload.'
}
finally {
  if ($workBase -and (Test-Path -LiteralPath $workBase)) {
    try { Remove-Item -LiteralPath $workBase -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  }
}
