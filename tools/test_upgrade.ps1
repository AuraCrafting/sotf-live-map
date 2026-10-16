<#
  Upgrade test for the map app: progress from earlier versions must come through intact.

    powershell -ExecutionPolicy Bypass -File tools\test_upgrade.ps1

  Publishes "SOTF Live Map.exe" to a temp folder and runs it on a spare port against made-up save games and
  progress files, then checks /api/state and progress.json. It never touches your real progress or saves.
  The installer side of an upgrade is tested by tools\test_install.ps1.
  Exit code: the number of failed checks.
#>
param([int]$Port = 8799)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$T = Join-Path ([IO.Path]::GetTempPath()) ('livemap-upgrade-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$App = Join-Path $T 'app'
$MapExe = Join-Path $App 'SOTF Live Map.exe'
$Base = "http://127.0.0.1:$Port"
. (Join-Path $PSScriptRoot 'testlib.ps1')

# The old Python map's progress.json: one shared set of found markers and pins, trail points without a world.
$Legacy = '{"found":[1,2,3],"pins":[{"id":"p1","x":10,"y":20,"label":"Base","kind":"note","t":1}],' +
          '"trail":[{"x":1,"y":2,"t":100,"s":"live"},{"x":5,"y":6,"t":200,"s":"save","l":"old"}],"seenSaves":["old@1"]}'

try {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "port $Port is in use; pass -Port" }
    Write-Host "Publishing the map app to $App"
    & dotnet publish (Join-Path $Root 'src\LiveMap.App\LiveMap.App.csproj') -c Release -nologo -v q -o $App
    if ($LASTEXITCODE -ne 0) { throw 'publish failed' }
    New-Item -ItemType Directory -Force (Join-Path $App 'web') | Out-Null # the static files aren't tested here

    # world-b saved first, then world-a, then a save without a world id (newest): old progress belongs to world-a
    $saves = Join-Path $T 'saves'
    New-Save $saves '1000000001' 'world-b' 100 200 '2026-01-01T10:00:00+00:00'
    New-Save $saves '1000000002' 'world-a' 300 400 '2026-01-02T10:00:00+00:00'
    New-Save $saves '1000000003' $null 500 600 '2026-01-03T10:00:00+00:00'
    $noSaves = Join-Path $T 'no-saves'
    New-Item -ItemType Directory -Force $noSaves | Out-Null

    Write-Host "`n1. Old-format progress.json, saves with world ids"
    $data = Join-Path $T 'data1'
    Set-Json "$data\progress.json" $Legacy
    $s = Start-Map $data $saves
    Check 'found markers go to the world saved last' ((Found (World $s 'world-a')).Count -eq 3)
    Check 'pins go to the world saved last' (@((World $s 'world-a').pins).Count -eq 1)
    Check 'the other world gets nothing' ((Found (World $s 'world-b')).Count -eq 0)
    Check 'old trail is kept and tagged with that world' (@($s.trail | Where-Object { $_.t -eq 100 -and $_.w -eq 'world-a' }).Count -eq 1)
    Stop-Map
    $f = Read-Json "$data\progress.json"
    Check 'progress.json is rewritten in the new format' ($f.worlds.'world-a'.found.Count -eq 3 -and $null -eq $f.found -and $null -eq $f.legacy)

    Write-Host "`n2. Old-format progress.json before any save says which world it is"
    $data = Join-Path $T 'data2'
    Set-Json "$data\progress.json" $Legacy
    $null = Start-Map $data $noSaves
    $null = Post '/api/pins' @{ action = 'save'; pin = @{ id = 'p2'; x = 1; y = 1; label = 'New' } } # makes the map save
    $f = Read-Json "$data\progress.json"
    Check 'saving before the world is known keeps the old found markers and pins' ($f.legacy.found.Count -eq 3 -and $f.legacy.pins.Count -eq 1)
    $null = Post '/api/position' @{ x = 50; y = 5; z = 60; heading = 0; world = 'world-c' }
    $s = Invoke-RestMethod "$Base/api/state"
    Check 'the live game says the world: they go there' ((Found (World $s 'world-c')).Count -eq 3)
    Stop-Map
    $f = Read-Json "$data\progress.json"
    Check '... and that is saved straight away' ($f.worlds.'world-c'.found.Count -eq 3 -and $null -eq $f.legacy)

    Write-Host "`n3. The installer put old progress next to the app; the progress here is still empty (the 2.2.0 bug)"
    $import = Join-Path $App 'import\progress.json'
    Set-Json $import $Legacy
    $data = Join-Path $T 'data3'
    Set-Json "$data\progress.json" '{"worlds":{"world-a":{"found":[],"pins":[]}},"trail":[{"x":7,"y":8,"t":300,"s":"save","w":"world-a"}],"seenSaves":["x@1"]}'
    $s = Start-Map $data $saves
    Check 'the old progress is imported' ((Found (World $s 'world-a')).Count -eq 3 -and @((World $s 'world-a').pins).Count -eq 1)
    Check 'the trail of both files is kept' (@($s.trail | Where-Object { $_.t -eq 100 -or $_.t -eq 300 }).Count -eq 2)
    Check 'the replaced file is backed up' (Test-Path "$data\progress.before-import.json")
    $null = Post '/api/found' @{ ids = @(1, 2, 3); found = $false; world = 'world-a' }
    Stop-Map
    $s = Start-Map $data $saves
    Check 'after clearing them yourself, a restart does not import them again' ((Found (World $s 'world-a')).Count -eq 0)
    Stop-Map

    Write-Host "`n3b. The installer put old progress next to the app; no progress here yet (a first install)"
    $data = Join-Path $T 'data3b'
    $s = Start-Map $data $saves
    Check 'the old progress is imported' ((Found (World $s 'world-a')).Count -eq 3)
    Stop-Map
    Check '... and saved in the new format' ((Read-Json "$data\progress.json").worlds.'world-a'.found.Count -eq 3)

    Write-Host "`n4. Old progress next to the app, but this version already has progress"
    $data = Join-Path $T 'data4'
    Set-Json "$data\progress.json" '{"worlds":{"world-a":{"found":[9],"pins":[]}},"trail":[],"seenSaves":[]}'
    $s = Start-Map $data $saves
    Check 'your current progress is kept as it is' (((Found (World $s 'world-a')) -join ',') -eq '9')
    Check 'nothing is backed up or replaced' (-not (Test-Path "$data\progress.before-import.json"))
    Stop-Map
    Remove-Item $import -Force

    Write-Host "`n5. A damaged progress.json"
    $data = Join-Path $T 'data5'
    Set-Json "$data\progress.json" '{"found":[1,2'
    $null = Start-Map $data $saves
    Stop-Map
    Check 'is kept as progress.bad.json' ((Get-Content "$data\progress.bad.json" -Raw) -eq '{"found":[1,2')

    Write-Host "`n6. A progress.json another program keeps locked"
    $data = Join-Path $T 'data6'
    Set-Json "$data\progress.json" $Legacy
    $lock = [IO.File]::Open("$data\progress.json", 'Open', 'Read', 'None')
    try {
        $null = Start-Map $data $saves 20
        $null = Post '/api/found' @{ ids = @(4); found = $true; world = 'world-a' }
    } finally { $lock.Dispose() }
    $null = Post '/api/found' @{ ids = @(5); found = $true; world = 'world-a' }
    Stop-Map
    Check 'is never overwritten' ((Get-Content "$data\progress.json" -Raw) -eq $Legacy)

    # Until 2.2 the map was called SOTF Field Map and kept its progress in %LOCALAPPDATA%\SOTF Field Map;
    # the map looks for that folder next to its own (here: next to the --data folder).
    $Current = '{"worlds":{"world-a":{"found":[7,8],"pins":[{"id":"p7","x":1,"y":2,"label":"Camp","kind":"base","t":5}],' +
               '"target":{"x":1,"y":2,"label":"Camp","kind":"pin","id":"pin:p7","t":6}}},' +
               '"trail":[{"x":3,"y":4,"t":400,"s":"live","w":"world-a"}],"seenSaves":["s@1"]}'

    Write-Host "`n7. Progress in the old 'SOTF Field Map' folder, nothing in the new one"
    $local = Join-Path $T 'local7'
    Set-Json "$local\SOTF Field Map\progress.json" $Current
    Set-Json "$local\SOTF Field Map\progress.before-import.json" $Legacy
    $s = Start-Map "$local\SOTF Live Map" $saves
    $w = World $s 'world-a'
    Check 'found markers, pins and the target come along on the first start' ((((Found $w) -join ',') -eq '7,8') -and @($w.pins).Count -eq 1 -and $w.target.label -eq 'Camp')
    Check '... and the trail' (@($s.trail | Where-Object { $_.t -eq 400 }).Count -eq 1)
    Stop-Map
    Check 'the old folder is gone' (-not (Test-Path "$local\SOTF Field Map"))
    Check 'its other files moved too' ((Get-Content "$local\SOTF Live Map\progress.before-import.json" -Raw) -eq $Legacy)

    Write-Host "`n8. Progress in both folders"
    $local = Join-Path $T 'local8'
    Set-Json "$local\SOTF Live Map\progress.json" '{"worlds":{"world-a":{"found":[9],"pins":[]}},"trail":[],"seenSaves":[]}'
    Set-Json "$local\SOTF Field Map\progress.json" $Current
    $s = Start-Map "$local\SOTF Live Map" $saves
    Check 'the new folder is kept as it is' (((Found (World $s 'world-a')) -join ',') -eq '9')
    Stop-Map
    $kept = @(Get-ChildItem "$local\SOTF Live Map" -Filter 'progress.old-*.json')
    Check 'the old progress is kept next to it' ($kept.Count -eq 1 -and (Get-Content $kept[0].FullName -Raw) -eq $Current)
    Check 'the old folder is gone' (-not (Test-Path "$local\SOTF Field Map"))

    Write-Host "`n9. An empty progress.json in the new folder, progress in the old one"
    $local = Join-Path $T 'local9'
    $empty = '{"worlds":{"world-a":{"found":[],"pins":[]}},"trail":[],"seenSaves":[]}'
    Set-Json "$local\SOTF Live Map\progress.json" $empty
    Set-Json "$local\SOTF Field Map\progress.json" $Current
    $s = Start-Map "$local\SOTF Live Map" $saves
    Check 'the old progress is used' (((Found (World $s 'world-a')) -join ',') -eq '7,8')
    Stop-Map
    $replaced = @(Get-ChildItem "$local\SOTF Live Map" -Filter 'progress.replaced-*.json')
    Check 'the empty file it replaced is kept' ($replaced.Count -eq 1 -and (Get-Content $replaced[0].FullName -Raw) -eq $empty)

    Write-Host "`n10. A second copy of the map, while one is running"
    $null = Start-Map (Join-Path $T 'data10') $saves
    $local = Join-Path $T 'local10'
    Set-Json "$local\SOTF Field Map\progress.json" $Current
    $second = Start-Process -FilePath $MapExe -PassThru -WindowStyle Hidden `
        -ArgumentList '--port', $Port, '--local-only', '--no-open', '--data', "`"$local\SOTF Live Map`"", '--saves', "`"$saves`""
    Check 'it stops at once' ($second.WaitForExit(10000))
    Check 'and leaves the old folder alone' ((Test-Path "$local\SOTF Field Map\progress.json") -and -not (Test-Path "$local\SOTF Live Map"))
    Stop-Map

    Write-Host "`n11. Location ids beyond 32 bits (41 locations have one, like 1713858317296)"
    $data = Join-Path $T 'data11'
    Set-Json "$data\progress.json" '{"found":[1713858317296,2],"pins":[],"trail":[],"seenSaves":[]}'
    $s = Start-Map $data $saves
    Check 'an old file with one comes through whole' (((Found (World $s 'world-a')) -join ',') -eq '2,1713858317296')
    $r = Post '/api/found' @{ ids = @(1712088096993); found = $true; world = 'world-a' }
    Check 'marking another one as found works' ((@($r.found) -join ',') -eq '2,1712088096993,1713858317296')
    $r = Post '/api/found' @{ ids = @(1713858317296); found = $false; world = 'world-a' }
    Check '... and so does unmarking' ((@($r.found) -join ',') -eq '2,1712088096993')
    Stop-Map
    Check 'and it is saved' (((Read-Json "$data\progress.json").worlds.'world-a'.found -join ',') -eq '2,1712088096993')

    Write-Host "`n12. Explore's lists: locked spots you've been near, and what you chose to reveal"
    $data = Join-Path $T 'data12'
    $null = Start-Map $data $saves
    $r = Post '/api/marks' @{ kind = 'encountered'; ids = @(19, 20, 1713858317296); world = 'world-a' }
    Check 'encountered spots are kept per world' ((@($r.ids) -join ',') -eq '19,20,1713858317296')
    $r = Post '/api/marks' @{ kind = 'revealed'; ids = @(17); world = 'world-a' }
    $r = Post '/api/marks' @{ kind = 'revealed'; ids = @(17); on = $false; world = 'world-a' }
    Check 'a reveal can be taken back' (@($r.ids).Count -eq 0)
    try { $null = Post '/api/marks' @{ kind = 'found'; ids = @(1); world = 'world-a' }; $bad = $false } catch { $bad = $true }
    Check 'other lists are refused' $bad
    $s = Invoke-RestMethod "$Base/api/state"
    Check 'the map lists them with the world' ((@((World $s 'world-a').encountered) -join ',') -eq '19,20,1713858317296' -and @((World $s 'world-b').encountered).Count -eq 0)
    Stop-Map
    Check 'and they are saved' (((Read-Json "$data\progress.json").worlds.'world-a'.encountered -join ',') -eq '19,20,1713858317296')

    Write-Host "`n13. What a save says about where you've been, and the trail's height"
    $hs = Join-Path $T 'saves13'
    New-Save $hs '3000000001' 'world-h' 100 200 '2026-01-05T10:00:00+00:00' @{
        'PlayerInventorySaveData.json' = Wrap 'PlayerInventory' @{ ItemInstanceManagerData = @{ Items = @(@{ ItemId = 356; TotalCount = 1 }, @{ ItemId = 471 }) } }
        'ZipLineManagerSaveData.json' = Wrap 'ZipLineManager' @{ Ziplines = @(@{ _anchorAPosition = @{ x = 1.5; y = 90; z = 2.5 }; _anchorBPosition = @{ x = 30; y = 80; z = 40 } }) }
    } @(@{ Name = 'PointOfInterestFound_Bunker Entertainment'; BoolValue = $true }, @{ Name = 'PointOfInterestFound_Other'; BoolValue = $false })
    $s = Start-Map (Join-Path $T 'data13') $hs
    $h = (World $s 'world-h').history
    Check 'the items you carry' ((@($h.items) -join ',') -eq '356,471')
    Check 'the places the game says you found' ((@($h.pois) -join ',') -eq 'Bunker Entertainment')
    Check 'both ends of your zip lines' (@($h.spots).Count -eq 2 -and $h.spots[0].x -eq 1.5 -and $h.spots[0].h -eq 90)
    $null = Post '/api/position' @{ x = 500; y = 96; z = 500; heading = 0; cave = $false; area = 0; world = 'world-h' }
    $null = Post '/api/position' @{ x = 501; y = 61; z = 500; heading = 0; cave = $true; area = 64; world = 'world-h' }
    $null = Post '/api/position' @{ x = 502; y = 61.5; z = 501; heading = 0; cave = $true; area = 64; world = 'world-h' }
    $null = Post '/api/position' @{ x = 503; y = 96; z = 500; heading = 0; cave = $false; area = 0; world = 'world-h' }
    $live = @((Invoke-RestMethod "$Base/api/state").trail | Where-Object { $_.s -eq 'live' -and $_.w -eq 'world-h' })
    Check 'going underground at the same spot is a new step, with its height' ((($live | ForEach-Object { "$($_.h)$(if ($_.c) { 'u' })" }) -join ',') -eq '96,61u,96')
    Stop-Map

    Write-Host "`n14. What you changed in the world, from every save of it"
    # the game's key: x, height and z as little-endian int32s in 1/4096 m, in hex
    function LocatorKey([double]$x, [double]$h, [double]$z) { -join (@($x, $h, $z) | ForEach-Object { [BitConverter]::GetBytes([int][Math]::Round($_ * 4096)) } | ForEach-Object { $_.ToString('X2') }) }
    function Locators($keys) { Wrap 'WorldObjectLocatorManager' @{ SerializedStates = @($keys | ForEach-Object { @{ Key = $_; Value = 1 } }) } }
    $cs = Join-Path $T 'saves14'
    New-Save $cs '3000000002' 'world-c' 0 0 '2026-01-05T10:00:00+00:00' @{
        'WorldObjectLocatorManagerSaveData.json' = Locators @((LocatorKey -703.3 101.2 449.6), (LocatorKey 10 50 20))
    }
    New-Save $cs '3000000003' 'world-c' 0 0 '2026-01-06T10:00:00+00:00' @{
        # the same felled tree again, a new one, a cave right under the second (another spot), and a broken key
        'WorldObjectLocatorManagerSaveData.json' = Locators @((LocatorKey -703.3 101.2 449.6), (LocatorKey 300.9 80 -40.1), (LocatorKey 10 10 20), 'NOT-A-KEY')
    }
    $s = Start-Map (Join-Path $T 'data14') $cs
    $g = @((World $s 'world-c').history.changed)
    $t1 = ([DateTimeOffset]'2026-01-05T10:00:00+00:00').ToUnixTimeSeconds()
    $t2 = ([DateTimeOffset]'2026-01-06T10:00:00+00:00').ToUnixTimeSeconds()
    Check 'one group per save, oldest first, with its save time' ($g.Count -eq 2 -and $g[0].t -eq $t1 -and $g[1].t -eq $t2)
    Check 'positions are decoded to the middle of their 2 m cell, with the height' ((@($g[0].p) -join ',') -eq '-703,449,101,11,21,50')
    Check 'a later save only brings what is new (a spot under another counts)' ((@($g[1].p) -join ',') -eq '301,-41,80,11,21,10')
    Stop-Map

    Write-Host "`n15. Gliders you put down"
    $gs = Join-Path $T 'saves15'
    New-Save $gs '3000000004' 'world-g' 0 0 '2026-01-07T10:00:00+00:00' @{
        'WorldItemManagerSaveData.json' = Wrap 'WorldItemManager' @{ WorldItemStates = @(
            @{ ObjectNameId = 'World.HangGlider.01'; ItemId = 626; Position = @{ x = -504.4; y = 322.9; z = -307.4 }; Rotation = @{ x = 0; y = 10; z = 0 } },
            @{ ObjectNameId = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'; ItemId = 626; Position = @{ x = -955.5; y = 88.2; z = 840.25 }; Rotation = @{ x = 0; y = -90; z = 0 } },
            @{ ObjectNameId = '11111111-2222-3333-4444-555555555555'; ItemId = 626; Position = @{ x = 0; y = 0; z = 0 }; Rotation = @{ x = 0; y = 0; z = 0 } },
            @{ ObjectNameId = '22222222-3333-4444-5555-666666666666'; ItemId = 590; Position = @{ x = 10; y = 5; z = 10 }; Rotation = @{ x = 0; y = 0; z = 0 } }) }
    }
    $s = Start-Map (Join-Path $T 'data15') $gs
    $v = @((World $s 'world-g').vehicles)
    $mine = @($v | Where-Object { $_.mine })
    Check "the island's own glider is still listed" (@($v | Where-Object { $_.id -eq 'World.HangGlider.01' -and -not $_.mine }).Count -eq 1)
    Check 'a glider you put down is listed as yours, where you left it' ($mine.Count -eq 1 -and $mine[0].id -eq '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' -and $mine[0].k -eq 'glider' -and $mine[0].x -eq -955.5 -and $mine[0].y -eq 840.25 -and $mine[0].heading -eq 270)
    Check 'one in your inventory (no position) and other dropped things are not' ($v.Count -eq 2)
    Stop-Map
}
finally {
    Stop-Map
    Remove-Item $T -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:failures) { Write-Host "$($script:failures) check(s) failed." -ForegroundColor Red }
else { Write-Host 'All upgrade checks passed.' -ForegroundColor Green }
exit $script:failures
