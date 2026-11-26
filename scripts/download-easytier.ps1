$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $repoRoot "resources\easytier"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$fallbackTag = "v2.6.4"
$downloadUrl = "https://github.com/EasyTier/EasyTier/releases/download/$fallbackTag/easytier-windows-x86_64-$fallbackTag.zip"
$assetName = "easytier-windows-x86_64-$fallbackTag.zip"
$tagName = $fallbackTag

try {
    Write-Host "Fetching latest EasyTier release from GitHub..." -ForegroundColor Cyan
    $headers = @{ "User-Agent" = "EriiRemote-Builder" }
    if ($env:GITHUB_TOKEN) {
        $headers["Authorization"] = "Bearer $($env:GITHUB_TOKEN)"
    }
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/EasyTier/EasyTier/releases/latest" -Headers $headers -TimeoutSec 20
    $asset = $release.assets | Where-Object { $_.name -match 'easytier-windows-x86_64-.*\.zip$' } | Select-Object -First 1
    if ($asset) {
        $downloadUrl = $asset.browser_download_url
        $assetName = $asset.name
        $tagName = $release.tag_name
    }
} catch {
    Write-Host "GitHub API lookup failed ($($_.Exception.Message)), falling back to $fallbackTag direct URL." -ForegroundColor Yellow
}

$tmpZip = Join-Path $env:TEMP $assetName
$tmpExtract = Join-Path $env:TEMP "easytier-extract-$(Get-Random)"
Write-Host "Downloading $assetName ($tagName)..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpZip -UseBasicParsing

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
Write-Host "Done! EasyTier $tagName is ready in resources/easytier." -ForegroundColor Green
