# Prints the access code from the encrypted vault.

$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root "runtime\node"
$env:PATH = "$node;$env:PATH"

Set-Location $root
$code = & (Join-Path $node "node.exe") --import tsx scripts\access-code.ts
Write-Host ""
Write-Host "Access code: $code" -ForegroundColor Cyan
Write-Host ""
