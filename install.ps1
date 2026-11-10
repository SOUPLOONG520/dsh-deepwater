<#
.SYNOPSIS
  Installs dsh-deepwater into a DSH profile.

.DESCRIPTION
  The package is copied into the profile's node_modules, the profile's
  package.json gains a link to it, and cordis.patch.yml gains the single
  `- insert:` row that mounts it.

  The script is deliberately conservative: it takes a backup of both profile
  files before it touches them, and it refuses to write if the profile does not
  look like a DSH profile.

  After it finishes, restart the desktop app. The desktop app captures its
  index injection at startup, so a running window will not pick up the new
  bundle until it comes back up.

.PARAMETER ProfileDir
  The profile directory. Defaults to $env:DSH_HOME\profiles\desktop.

.PARAMETER PackageDir
  This package. Defaults to the directory this script lives in.

.PARAMETER Uninstall
  Remove the row, the dependency and the copied package.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = (Join-Path $env:DSH_HOME 'profiles\desktop'),
  [string]$PackageDir = $PSScriptRoot,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Read-Text([string]$Path) {
  return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Write-Text([string]$Path, [string]$Text) {
  # UTF-8 without a BOM: the profile files are read by Node and by Cordis, and a
  # BOM in front of a YAML document is a different document.
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$profilePackage = Join-Path $ProfileDir 'package.json'
$moduleDir = Join-Path $ProfileDir 'node_modules\dsh-deepwater'

if (-not (Test-Path $patchFile)) {
  throw "This does not look like a DSH profile: $patchFile is missing."
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $ProfileDir ".deepwater-backup-$stamp"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item $patchFile (Join-Path $backupDir 'cordis.patch.yml') -Force
if (Test-Path $profilePackage) {
  Copy-Item $profilePackage (Join-Path $backupDir 'package.json') -Force
}
Write-Step "Backed the profile up to $backupDir"

if ($Uninstall) {
  Write-Step 'Removing the mount row'
  $patch = Read-Text $patchFile
  $patch = [System.Text.RegularExpressions.Regex]::Replace(
    $patch,
    '(?ms)^- insert:\r?\n\s*- id: deepwater\r?\n(?:\s+.*\r?\n)*',
    '')
  Write-Text $patchFile $patch
  if (Test-Path $moduleDir) {
    Remove-Item $moduleDir -Recurse -Force
  }
  Write-Step 'Done. Restart the desktop app.'
  return
}

Write-Step 'Copying the package into the profile'
if (Test-Path $moduleDir) {
  Remove-Item $moduleDir -Recurse -Force
}
New-Item -ItemType Directory -Path $moduleDir -Force | Out-Null
Copy-Item (Join-Path $PackageDir 'src') -Destination $moduleDir -Recurse -Force
Copy-Item (Join-Path $PackageDir 'verify') -Destination $moduleDir -Recurse -Force
foreach ($file in @('client.js', 'cordis.patch.yml', 'entry.js', 'build-client.mjs', 'package.json', 'README.md', 'LICENSE')) {
  $source = Join-Path $PackageDir $file
  if (Test-Path $source) {
    Copy-Item $source (Join-Path $moduleDir $file) -Force
  }
}

Write-Step 'Linking the package into the profile package.json'
if (Test-Path $profilePackage) {
  $json = Read-Text $profilePackage | ConvertFrom-Json
  if (-not $json.dependencies) {
    $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([PSCustomObject]@{})
  }
  $json.dependencies | Add-Member -NotePropertyName 'dsh-deepwater' -NotePropertyValue "link:$moduleDir" -Force
  Write-Text $profilePackage ($json | ConvertTo-Json -Depth 20)
}

Write-Step 'Adding the mount row to cordis.patch.yml'
$patch = Read-Text $patchFile
if ($patch -notmatch '(?m)^\s*- id: deepwater\s*$') {
  $row = @"

# dsh-deepwater: the surface and ambience layers, mounted as one row.
# Turn this row off to take the whole frame back down; the client half's
# disposer restores the stock appearance.
- insert:
  - id: deepwater
    name: dsh-deepwater
    config:
      enabled: true
      preset: roomy
      ambience: true
"@
  Write-Text $patchFile ($patch.TrimEnd() + "`r`n" + $row.TrimStart())
}

Write-Step 'Verifying the package'
Push-Location $moduleDir
try {
  & node --check (Join-Path $moduleDir 'src\ambient.js')
  & node (Join-Path $moduleDir 'verify\verify-deepwater.mjs')
} finally {
  Pop-Location
}

Write-Step 'Done. Restart the desktop app so it picks up the new bundle.'
