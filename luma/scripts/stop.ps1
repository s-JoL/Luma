# Stops the server and the tunnel started by start.ps1. Falls back to whoever
# holds the port, so a run started by hand is still cleaned up.
#
#   -IncludeComfy  also stop the image backend, which start.ps1 deliberately
#                  does not do: it calls this before every launch and ComfyUI
#                  costs a minute to load its models again.

param(
  [int]$Port = 8090,
  [switch]$IncludeComfy
)

$root = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $root "run"

foreach ($name in "luma", "tunnel") {
  $pidFile = Join-Path $runDir "$name.pid"
  if (-not (Test-Path $pidFile)) { continue }
  $recorded = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($recorded) {
    Stop-Process -Id ([int]$recorded) -Force -ErrorAction SilentlyContinue
    Write-Host "stopped $name (pid $recorded)"
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}

foreach ($owner in (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess) {
  Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
  Write-Host "stopped listener on $Port (pid $owner)"
}

# MCP servers are stdio children of the server process. A forced stop never runs
# the graceful shutdown that would close them, so they survive their parent and
# accumulate across restarts. With the server already gone, anything left running
# out of this directory is an orphan.
$stray = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$root*" }
foreach ($process in $stray) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host "stopped orphaned child (pid $($process.ProcessId))"
}

if ($IncludeComfy) {
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*ComfyUI*main.py*" } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "stopped ComfyUI (pid $($_.ProcessId))"
    }
  Remove-Item (Join-Path (Split-Path -Parent $root) "run\comfy.pid") -ErrorAction SilentlyContinue
}
