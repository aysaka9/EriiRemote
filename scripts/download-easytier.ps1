$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $repoRoot "resources\easytier"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

Write-Host "Fetching latest EasyTier release from GitHub..." -ForegroundColor Cyan
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/EasyTier/EasyTier/releases/latest" -TimeoutSec 20
$asset = $release.assets | Where-Object { $_.name -match 'easytier-windows-x86_64-.*\.zip$' } | Select-Object -First 1
if (-not $asset) {
    throw "Could not find windows x86_64 zip asset in latest EasyTier release."
}

$tmpZip = Join-Path $env:TEMP $asset.name
$tmpExtract = Join-Path $env:TEMP "easytier-extract-$(Get-Random)"
Write-Host "Downloading $($asset.name) ($($release.tag_name))..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmpZip

Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
foreach ($file in @("easytier-core.exe", "easytier-cli.exe", "wintun.dll", "Packet.dll", "WinDivert64.sys")) {
    $found = Get-ChildItem -Path $tmpExtract -Recurse -Filter $file | Select-Object -First 1
    if ($found) {
        Copy-Item $found.FullName (Join-Path $targetDir $file) -Force
        Write-Host "  Copied $file" -ForegroundColor Green
    }
}

Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Done! EasyTier $($release.tag_name) is ready in resources/easytier." -ForegroundColor Green
