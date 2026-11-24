# 打包 FuliForge Bridge 为可安装的 .eext
# 用法: powershell -ExecutionPolicy Bypass -File bridge\build.ps1
$ErrorFormat = "plain"
$src = $PSScriptRoot
$root = Split-Path $src -Parent                 # FuliForge
$outDir = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 用正则取版本号：避免 Windows PowerShell 5.1 按 GBK 读 UTF-8 清单导致解析失败
$extRaw = Get-Content (Join-Path $src "extension.json") -Raw -Encoding UTF8
if ($extRaw -match '"version"\s*:\s*"([^"]+)"') { $version = $Matches[1] } else { $version = "0.0.0" }
$stage = Join-Path $env:TEMP ("ff-bridge-stage-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage "dist") | Out-Null

Copy-Item (Join-Path $src "extension.json") $stage
Copy-Item (Join-Path $src "dist\index.js") (Join-Path $stage "dist")
if (Test-Path (Join-Path $src "images")) {
  Copy-Item (Join-Path $src "images") $stage -Recurse
}

$zip = Join-Path $outDir ("fuliforge-bridge_v{0}.zip" -f $version)
$eext = Join-Path $outDir ("fuliforge-bridge_v{0}.eext" -f $version)
Remove-Item $zip, $eext -Force -ErrorAction SilentlyContinue

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
Move-Item $zip $eext
Remove-Item $stage -Recurse -Force

Write-Output ("打包完成: {0}  ({1:N0} bytes)" -f $eext, (Get-Item $eext).Length)
