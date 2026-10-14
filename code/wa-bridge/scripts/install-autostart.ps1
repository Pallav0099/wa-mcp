# OWNER-RUN ONLY: registers a per-user scheduled task that starts wa-bridge at logon and re-checks every
# 10 minutes (start.ps1 is idempotent, so the repetition doubles as a watchdog). Remove with:
#   Unregister-ScheduledTask -TaskName 'wa-bridge' -Confirm:$false
[CmdletBinding()] param()
$ErrorActionPreference = 'Stop'

$start = Join-Path $PSScriptRoot 'start.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT45S'
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)).Repetition
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'wa-bridge' -Action $action -Trigger $trigger -Settings $settings -Description 'Start the wa-bridge WhatsApp daemon (idempotent; repeats every 10 min as a watchdog).' -Force | Out-Null
Write-Output "registered scheduled task 'wa-bridge' (at logon + every 10 min)"
