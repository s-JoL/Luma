# Development loop: foreground server on the audit instance, no tunnel and no
# build. The data directory defaults to `data-audit` — the configuration-only
# clone from `audit-db.ts --clone` — so a test run never writes the real
# transcript. For real use run start.ps1 instead.

param(
  [int]$Port = 8095,
  [string]$AccessCode = "AUDITCODE",
  [string]$DataDir = "data-audit"
)

$root = Split-Path -Parent $PSScriptRoot
$env:PATH = "$(Join-Path $root 'runtime\node');$env:PATH"
$env:LUMA_PORT = "$Port"
$env:LUMA_ACCESS_CODE = $AccessCode
$env:LUMA_DATA_DIR = if ([System.IO.Path]::IsPathRooted($DataDir)) { $DataDir } else { Join-Path $root $DataDir }

if (-not (Test-Path $env:LUMA_DATA_DIR)) {
  Write-Host "no $DataDir yet — run: node --import tsx scripts/audit-db.ts --clone"
  exit 1
}

foreach ($owner in (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess) {
  Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
  Write-Host "stopped pid $owner"
}
Start-Sleep -Milliseconds 600

Set-Location $root
node --import tsx src/server/main.ts
