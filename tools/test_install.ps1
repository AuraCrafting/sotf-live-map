<#
  Installer test: upgrading from an earlier version keeps every world's found markers, pins, guide target and
  trail on the map's first start, moves the settings and the desktop shortcut, and leaves none of the old
  names behind. Two starting points: SOTF Field Map 2.2 (progress in %LOCALAPPDATA%\SOTF Field Map), and the
  first version (the Python map's flat progress.json, found through the [LiveMapPosition] settings).

    powershell -ExecutionPolicy Bypass -File tools\test_install.ps1 [-Package <dist folder>]
        [-Progress <a 2.2 progress.json>] [-LegacyProgress <an old flat progress.json>] [-Saves <a Saves folder>]

  Runs the package's install.ps1 with -Sandbox against a dummy game folder in %TEMP%, then the installed map
  on a spare port. -Progress, -LegacyProgress and -Saves are copied (never changed) to test with real data;
  made-up files are used otherwise. Exit code: the number of failed checks.
#>
param([string]$Package, [string]$Progress, [string]$LegacyProgress, [string]$Saves, [int]$Port = 8798)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Base = "http://127.0.0.1:$Port"
. (Join-Path $PSScriptRoot 'testlib.ps1')

if (-not $Package) {
    $Package = Get-ChildItem (Join-Path $Root 'dist') -Directory -Filter 'SOTF-Live-Map-*' | Sort-Object LastWriteTime | Select-Object -Last 1 -ExpandProperty FullName
}
if (-not $Package -or -not (Test-Path (Join-Path $Package 'installer\install.ps1'))) { throw 'No release package; run build\release.ps1 first or pass -Package.' }
$T = Join-Path ([IO.Path]::GetTempPath()) ('livemap-install-' + [guid]::NewGuid().ToString('N').Substring(0, 8))

# ---------- what to upgrade ----------
$madeUp = -not $Progress
if ($madeUp) {
    $Progress = Join-Path $T 'input\progress.json'
    Set-Json $Progress ('{"worlds":{"world-a":{"found":[1,2,3],"pins":[{"id":"p1","x":10,"y":20,"label":"Base","kind":"base","t":1}],' +
        '"target":{"x":10,"y":20,"label":"Base","kind":"pin","id":"pin:p1","t":2}},"world-b":{"found":[4],"pins":[]}},' +
        '"trail":[{"x":1,"y":2,"t":100,"s":"live","w":"world-a"},{"x":3,"y":4,"t":200,"s":"live","w":"world-b"}],"seenSaves":[]}')
}
if (-not $LegacyProgress) {
    $LegacyProgress = Join-Path $T 'input\legacy.json'
    Set-Json $LegacyProgress '{"found":[5,6],"pins":[{"id":"q1","x":1,"y":1,"label":"Stash","kind":"stash","t":3}],"trail":[{"x":9,"y":9,"t":50,"s":"live"}],"seenSaves":[]}'
}
$savesCopy = Join-Path $T 'saves'
if ($Saves) {
    Copy-Item -LiteralPath $Saves $savesCopy -Recurse # keeps the file times, so saves already seen stay seen
} else {
    # world-b saved first, world-a last: progress from before worlds belongs to world-a
    New-Save $savesCopy '1000000001' 'world-b' 100 200 '2026-01-01T10:00:00+00:00'
    New-Save $savesCopy '1000000002' 'world-a' 300 400 '2026-01-02T10:00:00+00:00'
}

# ---------- helpers ----------
function New-Game($dir, $cfg) {
    New-Item -ItemType Directory -Force "$dir\MelonLoader\net6", "$dir\Mods", "$dir\UserData" | Out-Null
    foreach ($f in 'SonsOfTheForest.exe', 'version.dll', 'MelonLoader\net6\MelonLoader.dll') { Set-Content -LiteralPath "$dir\$f" 'dummy' }
    [IO.File]::WriteAllText("$dir\UserData\MelonPreferences.cfg", $cfg)
}
function Install($game, $sandbox) {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Package 'installer\install.ps1') -GameDir $game -Yes -Sandbox $sandbox 2>&1
    $code = $LASTEXITCODE
    $out | ForEach-Object { "      | $_" } | Write-Host -ForegroundColor DarkGray
    return $code
}
function Section($cfgText, $name) {
    $m = [regex]::Match($cfgText, "(?ms)^\[$([regex]::Escape($name))\]\s*`$(.*?)(?=^\[|\z)")
    if ($m.Success) { return $m.Groups[1].Value } else { return $null }
}
function Old-Names($dirs) {
    @(foreach ($d in $dirs) { Get-ChildItem -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'FieldMap|Field Map|LiveMapPosition' } | ForEach-Object { $_.FullName } })
}
# one world's progress, for comparing before and after
function Summary($worldProgress) {
    $found = @($worldProgress.found | Where-Object { $null -ne $_ } | Sort-Object) -join ','
    $pins = @($worldProgress.pins | ForEach-Object { $_.id } | Sort-Object) -join ','
    $t = $worldProgress.target
    $target = if ($t) { "$($t.label)@$($t.x),$($t.y)" } else { '-' }
    "found [$found] pins [$pins] target $target"
}
function Point($p) { "$($p.t)|$($p.x)|$($p.y)" }
function Compare-Trail($before, $after, $label) {
    $have = @{}; foreach ($p in $after) { $have[(Point $p)] = $p }
    $missing = @($before | Where-Object { -not $have.ContainsKey((Point $_)) })
    $beforeKeys = @{}; foreach ($p in $before) { $beforeKeys[(Point $p)] = 1 }
    $extra = @($after | Where-Object { -not $beforeKeys.ContainsKey((Point $_)) })
    $note = if ($extra.Count) { " (+$($extra.Count) from saves made since)" } else { ' (identical)' }
    Check "$label trail: $(@($before).Count) points before, $(@($after).Count) after$note" ($missing.Count -eq 0 -and @($extra | Where-Object { $_.s -ne 'save' }).Count -eq 0)
}
$cfgOther = "[SomeOtherMod]`nSetting = 1`n"

try {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "port $Port is in use; pass -Port" }
    Write-Host "Package: $Package"
    $MapExe = $null

    # ======================================================================
    Write-Host "`nA. Upgrade from SOTF Field Map 2.2"
    $sb = Join-Path $T 'A'; $game = "$sb\game"; $local = "$sb\Local"
    $oldMap = "$sb\oldmap"; Set-Json "$oldMap\progress.json" ([IO.File]::ReadAllText($LegacyProgress)) # the Python map's file is still around
    New-Game $game ("[LiveMapPosition]`nMapUrl = `"http://127.0.0.1:8765/api/position`"`nAutoStartMap = true`nMapFolder = '$oldMap'`n`n" +
        "[FieldMap]`nPort = 8765`nAutoStartMap = true`nMapExe = `"`"`nShowGuide = false`nGuideKey = `"F9`"`n`n" + $cfgOther)
    Set-Content -LiteralPath "$game\Mods\SOTFFieldMap.dll" 'old mod'
    New-Item -ItemType Directory -Force "$game\FieldMap\web" | Out-Null; Set-Content -LiteralPath "$game\FieldMap\FieldMap.exe" 'old map'
    New-Item -ItemType Directory -Force "$sb\Desktop" | Out-Null; Set-Content -LiteralPath "$sb\Desktop\SOTF Field Map.lnk" 'old shortcut'
    New-Item -ItemType Directory -Force "$local\SOTF Field Map" | Out-Null
    Copy-Item -LiteralPath $Progress "$local\SOTF Field Map\progress.json"
    Set-Json "$local\SOTF Field Map\progress.before-import.json" '{"found":[],"pins":[]}'
    $before = Read-Json "$local\SOTF Field Map\progress.json"

    Check 'the installer finishes' ((Install $game $sb) -eq 0)
    Check 'new mod and map are in place' ((Test-Path "$game\Mods\SOTFLiveMap.dll") -and (Test-Path "$game\SOTFLiveMap\SOTF Live Map.exe") -and (Test-Path "$game\SOTFLiveMap\web\index.html"))
    Check 'the desktop shortcut is "SOTF Live Map" and opens the new map' ((Test-Path "$sb\Desktop\SOTF Live Map.lnk") -and
        (New-Object -ComObject WScript.Shell).CreateShortcut("$sb\Desktop\SOTF Live Map.lnk").TargetPath -eq "$game\SOTFLiveMap\SOTF Live Map.exe")
    $cfg = [IO.File]::ReadAllText("$game\UserData\MelonPreferences.cfg")
    $live = Section $cfg 'LiveMap'
    Check 'settings moved to [LiveMap]: ShowGuide, GuideKey, Port' ($live -match '(?m)^ShowGuide = false' -and $live -match '(?m)^GuideKey = "F9"' -and $live -match '(?m)^Port = 8765')
    Check 'the old [FieldMap] and [LiveMapPosition] sections are gone, other mods keep theirs' ($null -eq (Section $cfg 'FieldMap') -and $null -eq (Section $cfg 'LiveMapPosition') -and (Section $cfg 'SomeOtherMod') -match 'Setting = 1')
    Check 'the old settings are backed up' (@(Get-ChildItem "$game\UserData" -Filter 'MelonPreferences.cfg.before-live-map-*.bak').Count -eq 1)

    $MapExe = "$game\SOTFLiveMap\SOTF Live Map.exe"
    $s = Start-Map "$local\SOTF Live Map" $savesCopy 30
    foreach ($w in $before.worlds.PSObject.Properties) {
        $after = World $s $w.Name
        $label = $w.Name.Substring(0, [Math]::Min(8, $w.Name.Length))
        if (-not $after) { Check "world $label is on the map" $false; continue }
        Check "world ${label}: $(Summary $w.Value)" ((Summary $w.Value) -eq (Summary $after))
        Compare-Trail @($before.trail | Where-Object { $_.w -eq $w.Name }) @($s.trail | Where-Object { $_.w -eq $w.Name }) "world $label"
    }
    Check 'the old Python file did not replace your progress' ((Summary ($before.worlds.PSObject.Properties | Select-Object -First 1).Value) -eq (Summary (World $s ($before.worlds.PSObject.Properties | Select-Object -First 1).Name)))
    Stop-Map
    Check 'your progress moved to "SOTF Live Map", the old folder is gone' ((Test-Path "$local\SOTF Live Map\progress.json") -and (Test-Path "$local\SOTF Live Map\progress.before-import.json") -and -not (Test-Path "$local\SOTF Field Map"))
    $file = Read-Json "$local\SOTF Live Map\progress.json"
    Check 'progress.json on disk has the same found markers and pins' (@($before.worlds.PSObject.Properties | Where-Object { (Summary $_.Value) -ne (Summary $file.worlds.($_.Name)) }).Count -eq 0)
    $leftovers = Old-Names @($game, "$sb\Desktop", $local)
    Check "no old names left in the game folder, desktop or progress folder$(if ($leftovers) { ': ' + ($leftovers -join ', ') })" ($leftovers.Count -eq 0)

    Check 'installing again over it works' ((Install $game $sb) -eq 0)
    $cfg2 = [IO.File]::ReadAllText("$game\UserData\MelonPreferences.cfg")
    Check '... and changes no settings' ($cfg2 -eq $cfg)

    # ======================================================================
    Write-Host "`nB. Upgrade from the first version (the Python map's flat progress.json)"
    $sb = Join-Path $T 'B'; $game = "$sb\game"; $local = "$sb\Local"
    $oldMap = "$sb\oldmap"; Set-Json "$oldMap\progress.json" ([IO.File]::ReadAllText($LegacyProgress))
    New-Game $game ("[LiveMapPosition]`nMapUrl = `"http://127.0.0.1:8765/api/position`"`nAutoStartMap = true`nMapFolder = '$oldMap'`n")
    Set-Content -LiteralPath "$game\Mods\LiveMapPosition.dll" 'first mod'
    $legacy = Read-Json $LegacyProgress

    Check 'the installer finishes' ((Install $game $sb) -eq 0)
    Check 'the old progress waits next to the map' ((Get-Content "$game\SOTFLiveMap\import\progress.json" -Raw) -eq [IO.File]::ReadAllText($LegacyProgress))
    $live = Section ([IO.File]::ReadAllText("$game\UserData\MelonPreferences.cfg")) 'LiveMap'
    Check 'the port comes from the old MapUrl' ($live -match '(?m)^Port = 8765')
    $MapExe = "$game\SOTFLiveMap\SOTF Live Map.exe"
    $s = Start-Map "$local\SOTF Live Map" $savesCopy 30
    $newest = ($s.worlds | Where-Object { -not $_.new } | Sort-Object last | Select-Object -Last 1)
    Check "found markers and pins go to the world you saved last ($($newest.uid.Substring(0, [Math]::Min(8, $newest.uid.Length)))): $(Summary $legacy)" ((Summary $legacy) -eq (Summary $newest))
    Compare-Trail @($legacy.trail) @($s.trail) 'the old'
    $keys = @{}; foreach ($p in $s.trail) { $keys[(Point $p)] = $p.w }
    $untagged = @($legacy.trail | Where-Object { -not $_.w })
    Check "its $($untagged.Count) points without a world now belong to that world" (@($untagged | Where-Object { $keys[(Point $_)] -ne $newest.uid }).Count -eq 0)
    Stop-Map
    $leftovers = Old-Names @($game, "$sb\Desktop", $local)
    Check "no old names left$(if ($leftovers) { ': ' + ($leftovers -join ', ') })" ($leftovers.Count -eq 0)

    # ======================================================================
    Write-Host "`nC. The map's own port"
    if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) {
        Write-Host '  skip  8765 is in use (your running map); the [LiveMap] Port = 8765 checks above cover the setting' -ForegroundColor Yellow
    } else {
        $p = Start-Process -FilePath $MapExe -PassThru -WindowStyle Hidden -ArgumentList '--local-only', '--no-open', '--no-update-check', '--data', "`"$local\SOTF Live Map`"", '--saves', "`"$savesCopy`""
        $ok = $false
        foreach ($i in 1..50) { try { Invoke-RestMethod 'http://127.0.0.1:8765/api/state' -TimeoutSec 2 | Out-Null; $ok = $true; break } catch { Start-Sleep -Milliseconds 200 } }
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        Check 'without --port the map starts on 8765' $ok
    }
}
finally {
    Stop-Map
    Remove-Item $T -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:failures) { Write-Host "$($script:failures) check(s) failed." -ForegroundColor Red }
else { Write-Host 'All install checks passed.' -ForegroundColor Green }
exit $script:failures
