# Starts the ComfyUI backend that Luma's image tools call, unless it is already
# listening. The program is the Desktop installation under AppData, but its
# models, input and output are the workspace copies — that split is what
# --base-directory expresses. Without it ComfyUI silently falls back to the
# install's own empty model tree and every workflow fails on a missing
# checkpoint rather than on anything that names the real problem.
#
# Returns 0 when ComfyUI is running, 1 when it could not be started at all.
#
#   -ReadySeconds  how long to wait for a first answer before returning and
#                  leaving it to finish loading on its own

param(
  [int]$Port = 8188,
  [int]$ReadySeconds = 25
)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$install = "$env:LOCALAPPDATA\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI"
$python = Join-Path $install ".venv\Scripts\python.exe"
$assets = Join-Path $root "ComfyUI\shared"
$runDir = Join-Path $root "run"

function Reachable {
  try {
    Invoke-RestMethod "http://127.0.0.1:$Port/system_stats" -TimeoutSec 3 | Out-Null
    return $true
  } catch {
    return $false
  }
}

if (Reachable) {
  Write-Host "ComfyUI already up on $Port"
  exit 0
}

if (-not (Test-Path $python)) {
  Write-Host "ComfyUI not found at $install — image tools will be unavailable." -ForegroundColor Yellow
  exit 1
}

New-Item -ItemType Directory -Force -Path $runDir | Out-Null
Write-Host "starting ComfyUI..."

$process = Start-Process -FilePath $python `
  -ArgumentList "-s", (Join-Path $install "main.py"), "--base-directory", "`"$assets`"",
    "--listen", "127.0.0.1", "--port", "$Port", "--disable-auto-launch" `
  -WorkingDirectory $install -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $runDir "comfy.log") `
  -RedirectStandardError (Join-Path $runDir "comfy.err.log")
$process.Id | Set-Content (Join-Path $runDir "comfy.pid")

# Loading the model index and the custom nodes can take three minutes from a
# cold file cache, which is too long to hold a launcher window open. Waiting
# briefly still catches the failure that matters — a bad install or a busy port
# kills the process within seconds — and anything slower is just loading.
$deadline = (Get-Date).AddSeconds($ReadySeconds)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (Reachable) {
    Write-Host "ComfyUI is up on $Port (pid $($process.Id))"
    exit 0
  }
  if ($process.HasExited) {
    Write-Host "ComfyUI exited immediately; last output:" -ForegroundColor Red
    Get-Content (Join-Path $runDir "comfy.err.log") -Tail 15 -ErrorAction SilentlyContinue
    exit 1
  }
}

Write-Host "ComfyUI is still loading in the background (pid $($process.Id)); image tools work once it answers on $Port."
exit 0
