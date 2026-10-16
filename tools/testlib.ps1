# Helpers shared by test_upgrade.ps1 and test_install.ps1 (dot-sourced). The caller sets $MapExe, $Port, $Base.

$script:failures = 0
$script:proc = $null

function Check($name, $ok) {
    if ($ok) { Write-Host "  ok    $name" -ForegroundColor Green }
    else { Write-Host "  FAIL  $name" -ForegroundColor Red; $script:failures++ }
}

function Wrap($section, $obj) {
    # save files hold each section as a JSON string: {"Data": {"<Section>": "<json>"}}
    @{ Data = @{ $section = ($obj | ConvertTo-Json -Depth 10 -Compress) } } | ConvertTo-Json -Depth 10 -Compress
}

# $extraFiles: more sections ({ "<File>.json" = <wrapped json> }); $extraEntries: more PlayerState entries
function New-Save($savesDir, $slot, $world, $x, $z, $saveTime, [hashtable]$extraFiles = @{}, [array]$extraEntries = @()) {
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $dir = Join-Path $savesDir "76561190000000000\SinglePlayer\$slot"
    New-Item -ItemType Directory -Force $dir | Out-Null
    $settings = @(@{ Name = 'Mode'; StringValue = 'Normal' })
    if ($world) { $settings += @{ Name = 'UID'; StringValue = $world } }
    $files = @{
        'PlayerStateSaveData.json' = Wrap 'PlayerState' @{ _entries = @(@{ Name = 'player.position'; FloatArrayValue = @($x, 10, $z) }) + $extraEntries }
        'GameSetupSaveData.json'   = Wrap 'GameSetup' @{ _settings = $settings }
        'GameStateSaveData.json'   = Wrap 'GameState' @{ SaveTime = $saveTime; GameDays = 3; GameType = 'Normal' }
    }
    foreach ($k in $extraFiles.Keys) { $files[$k] = $extraFiles[$k] }
    $zip = [IO.Compression.ZipFile]::Open((Join-Path $dir 'SaveData.zip'), 'Create')
    try {
        foreach ($name in $files.Keys) {
            $w = New-Object IO.StreamWriter($zip.CreateEntry($name).Open())
            $w.Write($files[$name]); $w.Dispose()
        }
    } finally { $zip.Dispose() }
}

function Set-Json($path, $text) {
    New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
    [IO.File]::WriteAllText($path, $text)
}

function Read-Json($path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }

# The map never asks GitHub for updates in tests, except in test_update.ps1 (against a fake GitHub).
$script:CheckUpdates = $false
function Start-Map($data, $saves, [int]$waitSeconds = 15, [string[]]$extra = @()) {
    $mapArgs = @('--port', $Port, '--local-only', '--no-open', '--data', "`"$data`"", '--saves', "`"$saves`"") + $extra
    if (-not $script:CheckUpdates) { $mapArgs += '--no-update-check' }
    $script:proc = Start-Process -FilePath $MapExe -PassThru -WindowStyle Hidden -ArgumentList $mapArgs
    $until = (Get-Date).AddSeconds($waitSeconds)
    while ((Get-Date) -lt $until) {
        try { return Invoke-RestMethod "$Base/api/state" -TimeoutSec 2 } catch { Start-Sleep -Milliseconds 200 }
    }
    throw 'the map did not start'
}

# Killed, not closed: a hard stop must not lose anything (it doesn't get to write on exit).
function Stop-Map { if ($script:proc) { Stop-Process -Id $script:proc.Id -Force -ErrorAction SilentlyContinue; $script:proc.WaitForExit(); $script:proc = $null } }

function Post($path, $body) { Invoke-RestMethod -Method Post "$Base$path" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 10 -Compress) -TimeoutSec 5 }

function World($state, $uid) { $state.worlds | Where-Object { $_.uid -eq $uid } }

function Found($world) { @($world.found | Where-Object { $_ -ne $null }) }
