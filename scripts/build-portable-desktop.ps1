# scripts/build-portable-desktop.ps1
#
# Builds a portable (no-installer) Windows release of one or both Inaya
# desktop apps. Tauri's own Windows bundler only produces an NSIS
# installer (registry entries, Start Menu shortcut, uninstaller) -- there
# is no "portable" checkbox in Tauri's NSIS config (confirmed against the
# installed @tauri-apps/cli's own config schema). The real portable form
# doesn't need Tauri's bundler at all: `cargo build --release` already
# produces one standalone .exe, and since both apps point their webview
# at a live URL (inaya-desktop -> inayanetwork.com/business,
# inaya-dapp-desktop -> inayanetwork.com/) rather than bundling local
# frontend files, that one .exe has no accompanying folder it depends on
# at runtime -- copy it anywhere (a USB drive, a zip, whatever) and run
# it directly. No install step, no registry writes, no uninstaller.
#
# Requires the target machine to already have the Microsoft Edge WebView2
# Runtime installed -- present by default on Windows 10 1803+ and
# Windows 11, and on the vast majority of real machines already, but not
# guaranteed on every install the way the NSIS installer can auto-bootstrap
# it. Worth saying once here rather than assuming every user already knows.
#
# Usage:
#   .\scripts\build-portable-desktop.ps1                  # builds both apps
#   .\scripts\build-portable-desktop.ps1 -App desktop      # inaya-desktop only
#   .\scripts\build-portable-desktop.ps1 -App dapp         # inaya-dapp-desktop only

param(
  [ValidateSet("both", "desktop", "dapp")]
  [string]$App = "both"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $repoRoot "portable-builds"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$targets = @()
if ($App -eq "both" -or $App -eq "desktop") {
  $targets += [PSCustomObject]@{
    Dir = Join-Path $repoRoot "inaya-desktop\src-tauri"
    BinName = "inaya-desktop.exe"
    OutName = "Inaya-Business-Workspace-Portable.exe"
  }
}
if ($App -eq "both" -or $App -eq "dapp") {
  $targets += [PSCustomObject]@{
    Dir = Join-Path $repoRoot "inaya-dapp-desktop\src-tauri"
    BinName = "inaya-dapp-desktop.exe"
    OutName = "Inaya-Network-Portable.exe"
  }
}

foreach ($t in $targets) {
  Write-Host "==> Building release binary in $($t.Dir)" -ForegroundColor Cyan
  Push-Location $t.Dir
  try {
    cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build --release failed for $($t.Dir)" }
  } finally {
    Pop-Location
  }

  $builtExe = Join-Path $t.Dir "target\release\$($t.BinName)"
  if (-not (Test-Path $builtExe)) { throw "Expected binary not found: $builtExe" }

  $destExe = Join-Path $outDir $t.OutName
  Copy-Item -Path $builtExe -Destination $destExe -Force

  $zipPath = Join-Path $outDir ([System.IO.Path]::GetFileNameWithoutExtension($t.OutName) + ".zip")
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path $destExe -DestinationPath $zipPath

  Write-Host "==> Portable build ready: $destExe (also zipped: $zipPath)" -ForegroundColor Green
}

Write-Host "`nAll portable builds written to $outDir" -ForegroundColor Cyan
