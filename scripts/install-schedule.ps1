# Registers the two Windows scheduled tasks that make the system run by itself.
#
#     powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1
#
#   LinkedInAutomation-Image  - keeps the local image service alive (at logon)
#   LinkedInAutomation-Run    - checks the sheet every minute
#
# Both run as the current user, only while logged on, and start automatically
# after a reboot. Remove them with:
#
#     powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 -Remove

param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$imageTask = 'LinkedInAutomation-Image'
$runTask = 'LinkedInAutomation-Run'

if ($Remove) {
    foreach ($name in @($imageTask, $runTask)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Output "removed $name"
        } else {
            Write-Output "$name was not registered"
        }
    }
    return
}

if (-not $node) { throw 'node was not found on PATH.' }
Write-Output "project : $root"
Write-Output "node    : $node"

# --- image service: start at logon, keep running -------------------------
$imageAction = New-ScheduledTaskAction -Execute $node `
    -Argument 'local-image\server.js' -WorkingDirectory $root
$imageTrigger = New-ScheduledTaskTrigger -AtLogOn
$imageSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $imageTask -Action $imageAction -Trigger $imageTrigger `
    -Settings $imageSettings -Description 'Local image generator for the LinkedIn automation' -Force | Out-Null
Write-Output "registered $imageTask (at logon)"

# --- the run itself: every minute ----------------------------------------
# run-once.js exits immediately when nothing is due, so a one-minute cadence
# costs almost nothing and means a changed A1 takes effect within a minute.
$runAction = New-ScheduledTaskAction -Execute $node `
    -Argument 'scripts\run-once.js --live' -WorkingDirectory $root
$runTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)
$runSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable

Register-ScheduledTask -TaskName $runTask -Action $runAction -Trigger $runTrigger `
    -Settings $runSettings -Description 'Checks the LinkedIn content calendar every minute' -Force | Out-Null
Write-Output "registered $runTask (every minute)"

Start-ScheduledTask -TaskName $imageTask
Write-Output ''
Write-Output 'Done. The system is now live.'
Write-Output ('  log      : ' + (Join-Path $root 'run.log'))
Write-Output '  check     : Get-ScheduledTask LinkedInAutomation-*'
Write-Output '  run now   : Start-ScheduledTask -TaskName LinkedInAutomation-Run'
Write-Output '  stop all  : powershell -File scripts\install-schedule.ps1 -Remove'
