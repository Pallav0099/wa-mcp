# Stop the wa-bridge daemon: graceful shutdown through the API first, the lock-file PID only as a fallback.
[CmdletBinding()] param()
$ErrorActionPreference = 'Continue'

$repo = Split-Path -Parent $PSScriptRoot
$lock = Join-Path (Join-Path $env:LOCALAPPDATA 'wa-bridge') 'daemon.lock'

if (-not (Test-Path $lock)) { Write-Output 'wa-bridge is not running (no lock file)'; exit 0 }

& node (Join-Path $repo 'bin\wa.mjs') shutdown | Out-Null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Test-Path $lock)) { Write-Output 'wa-bridge stopped'; exit 0 }
}

$procId = [int](Get-Content $lock -Raw).Trim()
$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
if ($p -and $p.ProcessName -eq 'node') {
    Stop-Process -Id $procId -Force
    Write-Output "wa-bridge did not stop in 10 s; killed node pid $procId"
} else {
    Write-Output "stale lock (pid $procId is not a running node process)"
}
Remove-Item $lock -Force -ErrorAction SilentlyContinue
