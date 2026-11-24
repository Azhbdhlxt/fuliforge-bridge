# Build FuliForge Bridge into an installable .eext
# Run: powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$outDir = Join-Path $src "dist"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Read version with a regex: avoids GBK/UTF-8 manifest parsing issues on Windows PowerShell 5.1
$extRaw = Get-Content (Join-Path $src "extension.json") -Raw -Encoding UTF8
if ($extRaw -match '"version"\s*:\s*"([^"]+)"') { $version = $Matches[1] } else { $version = "0.0.0" }

$stage = Join-Path $env:TEMP ("ff-bridge-stage-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path (Join-Path $stage "dist") | Out-Null
Copy-Item (Join-Path $src "extension.json") $stage
Copy-Item (Join-Path $src "dist\index.js") (Join-Path $stage "dist")

$zip = Join-Path $outDir ("fuliforge-bridge_v{0}.zip" -f $version)
$eext = Join-Path $outDir ("fuliforge-bridge_v{0}.eext" -f $version)
Remove-Item $zip, $eext -Force -ErrorAction SilentlyContinue

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
Move-Item $zip $eext
Remove-Item $stage -Recurse -Force

Write-Output ("Built: {0}  ({1:N0} bytes)" -f $eext, (Get-Item $eext).Length)
