<#
.SYNOPSIS
  Start the local ComfyUI draft lane with the settings benchmarked for a 6 GB Quadro RTX 3000.

.DESCRIPTION
  Flags are measured, not guessed — see tools/comfy-workflows/README.md for the numbers.
  Notably we do NOT pass --lowvram or --use-split-cross-attention: on ComfyUI 0.33 with
  torch 2.13 both are counterproductive on this card.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\scripts\comfy-start.ps1
  powershell -ExecutionPolicy Bypass -File tools\scripts\comfy-start.ps1 -Port 8290 -Foreground
  powershell -ExecutionPolicy Bypass -File tools\scripts\comfy-start.ps1 -Stop
#>
[CmdletBinding()]
param(
  # 8188 is unusable on this machine: it sits inside a Windows reserved TCP exclusion
  # range (8163-8262, held by WinNAT/Hyper-V). Check with:
  #   netsh interface ipv4 show excludedportrange protocol=tcp
  [int]$Port = 8288,
  [string]$BindAddress = '127.0.0.1',
  [string]$ComfyHome = $(if ($env:COMFYUI_HOME) { $env:COMFYUI_HOME } else { 'D:\me\tools\ComfyUI' }),
  [int]$TimeoutSec = 120,
  [switch]$Foreground,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

function Get-ComfyPid {
  param([int]$P)
  $line = netstat -ano -p tcp | Select-String -Pattern ":$P\s" | Select-String -Pattern 'LISTENING'
  if (-not $line) { return $null }
  return ($line[0].ToString() -split '\s+' | Where-Object { $_ } | Select-Object -Last 1)
}

if ($Stop) {
  $existing = Get-ComfyPid -P $Port
  if ($existing) {
    Write-Host "Stopping ComfyUI (pid $existing) on port $Port"
    Stop-Process -Id $existing -Force
  } else {
    Write-Host "Nothing listening on port $Port"
  }
  exit 0
}

$Python = Join-Path $ComfyHome '.venv\Scripts\python.exe'
if (-not (Test-Path $Python)) { throw "ComfyUI venv python not found: $Python" }
if (-not (Test-Path (Join-Path $ComfyHome 'main.py'))) { throw "ComfyUI main.py not found under $ComfyHome" }

$existing = Get-ComfyPid -P $Port
if ($existing) {
  Write-Host "ComfyUI already listening on ${BindAddress}:${Port} (pid $existing)"
  exit 0
}

# Keep every byte ComfyUI writes inside the gitignored workspace.
$OutDir  = Join-Path $RepoRoot 'workspace\cache\comfy\output'
$TmpDir  = Join-Path $RepoRoot 'workspace\cache\comfy\temp'
$InDir   = Join-Path $RepoRoot 'workspace\cache\comfy\input'
$LogDir  = Join-Path $RepoRoot 'workspace\logs'
foreach ($d in @($OutDir, $TmpDir, $InDir, $LogDir)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

$ComfyArgs = @(
  'main.py'
  '--listen', $BindAddress
  '--port', $Port
  '--disable-auto-launch'      # headless: never pop a browser
  '--disable-all-custom-nodes' # reproducible node set; nothing here needs Manager
  '--preview-method', 'none'   # latent previews cost VRAM we do not have
  '--output-directory', $OutDir
  '--temp-directory', $TmpDir
  '--input-directory', $InDir
)

if ($Foreground) {
  Write-Host "Starting ComfyUI in the foreground on ${BindAddress}:${Port} (Ctrl-C to stop)"
  & $Python @ComfyArgs
  exit $LASTEXITCODE
}

$LogFile = Join-Path $LogDir 'comfyui.log'
Write-Host "Starting ComfyUI on ${BindAddress}:${Port}"
Write-Host "  python : $Python"
Write-Host "  log    : $LogFile"
$proc = Start-Process -FilePath $Python -ArgumentList $ComfyArgs -WorkingDirectory $ComfyHome `
  -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -PassThru -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) {
    Write-Error "ComfyUI exited with code $($proc.ExitCode). Tail of ${LogFile}.err:"
    if (Test-Path "$LogFile.err") { Get-Content "$LogFile.err" -Tail 25 | Write-Host }
    exit 1
  }
  try {
    $r = Invoke-RestMethod -Uri "http://${BindAddress}:${Port}/system_stats" -TimeoutSec 3
    $dev = $r.devices[0]
    $vram = [math]::Round($dev.vram_total / 1GB, 2)
    Write-Host "ComfyUI $($r.system.comfyui_version) ready at http://${BindAddress}:${Port} (pid $($proc.Id))"
    Write-Host "  device : $($dev.name), $vram GiB VRAM"
    Write-Host "  smoke  : node tools/scripts/comfy-smoke.mjs --host http://${BindAddress}:${Port}"
    Write-Host "  stop   : powershell -File tools\scripts\comfy-start.ps1 -Stop -Port $Port"
    exit 0
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

Write-Error "ComfyUI did not answer /system_stats within $TimeoutSec s. See $LogFile"
exit 1
