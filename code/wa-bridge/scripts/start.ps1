# Start the wa-bridge daemon hidden and detached (WMI Win32_Process.Create, ShowWindow 0).
# No console window exists to be closed by accident, and no terminal or Claude session owns the process.
# Idempotent: exits quietly if the daemon already answers on its port.
[CmdletBinding()] param()
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$data = Join-Path $env:LOCALAPPDATA 'wa-bridge'
$logs = Join-Path $data 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$port = 3210
$cfgFile = Join-Path $data 'config.json'
if (Test-Path $cfgFile) {
    $c = Get-Content $cfgFile -Raw | ConvertFrom-Json
    if ($c.port) { $port = [int]$c.port }
}

function Test-Port([int]$p) {
    $client = New-Object System.Net.Sockets.TcpClient
    try { return $client.ConnectAsync('127.0.0.1', $p).Wait(500) } catch { return $false } finally { $client.Dispose() }
}

if (Test-Port $port) { Write-Output "wa-bridge already answering on 127.0.0.1:$port"; exit 0 }

# The bridge's own pinned Node (v22.23.2), never whatever `node` PATH resolves to: PATH pointed at
# another product's bundled Node, so removing that product would have killed the bridge.
$node = Join-Path $env:LOCALAPPDATA 'Programs\wa-bridge-node\node.exe'
if (-not (Test-Path $node)) { throw "wa-bridge's Node is missing at $node (see VERSION-PIN.txt there)" }
$daemon = Join-Path $repo 'src\daemon.mjs'
$out = Join-Path $logs 'daemon-stdout.log'
$err = Join-Path $logs 'daemon-stderr.log'
$cmdLine = 'cmd.exe /d /c ""{0}" --disable-warning=ExperimentalWarning "{1}" 1>>"{2}" 2>>"{3}""' -f $node, $daemon, $out, $err

$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmdLine; CurrentDirectory = $repo; ProcessStartupInformation = $si
}
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed with code $($r.ReturnValue)" }

for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Port $port) { Write-Output "wa-bridge started (wrapper pid $($r.ProcessId)) on 127.0.0.1:$port"; exit 0 }
}
throw "wa-bridge did not open port $port within 15 s; see $err"
