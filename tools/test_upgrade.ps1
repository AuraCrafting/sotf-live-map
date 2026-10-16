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
    Check "the old version's trail is added to yours" (@($s.trail | Where-Object { $_.t -eq 100 -or $_.t -eq 200 }).Count -eq 2)
    Check '... its points get the world of the save nearest in time' (@($s.trail | Where-Object { ($_.t -eq 100 -or $_.t -eq 200) -and $_.w }).Count -eq 2)
    Stop-Map
    $s = Start-Map $data $saves
    Check '... and only once' (@($s.trail | Where-Object { $_.t -eq 100 }).Count -eq 1)
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

    Write-Host "`n16. Explore's fog: where you've been, kept apart from the trail"
    New-Item -ItemType Directory -Force (Join-Path $App 'web\data') | Out-Null
    Set-Content (Join-Path $App 'web\data\locations.js') -Encoding utf8 -Value @('// test data', 'window.SOTF_CATEGORIES = [];',
        'window.SOTF_LOCATIONS = [{"id":7001,"c":"camp","t":"A camp","x":-1000,"y":-1000},{"id":7002,"c":"tool","t":"In a cave","x":1000,"y":1000,"g":["In a cave"]}];')
    $es = Join-Path $T 'saves16'
    New-Save $es '3000000005' 'world-e' 100 200 '2026-01-08T10:00:00+00:00' @{
        'WorldObjectLocatorManagerSaveData.json' = Locators @((LocatorKey 300.9 80 -40.1))
    }
    $data = Join-Path $T 'data16'
    Set-Json "$data\progress.json" ('{"worlds":{"world-e":{"found":[7001],"pins":[]}},"seenSaves":[],"trail":[' +
        '{"x":-500,"y":500,"t":100,"s":"live","w":"world-e"},{"x":500,"y":-500,"t":101,"s":"live","w":"world-e","c":1}]}')
    # bit j * 400 + i of the 10 m cell at (x, z), lowest bit first
    function Cell($b64, [double]$x, [double]$z) { $b = [Convert]::FromBase64String($b64); $k = [int]([Math]::Floor(($z + 2000) / 10) * 400 + [Math]::Floor(($x + 2000) / 10)); [bool]($b[$k -shr 3] -band (1 -shl ($k -band 7))) }
    function Cells($b64) { $n = 0; foreach ($b in [Convert]::FromBase64String($b64)) { $v = [int]$b; while ($v) { $n += $v -band 1; $v = $v -shr 1 } }; $n }
    function Explored { (World (Invoke-RestMethod "$Base/api/state") 'world-e').explored }
    $s = Start-Map $data $es
    $e = (World $s 'world-e').explored
    Check 'the first time it comes from history: the save, a trail step, a changed object, a found place' ((Cell $e 100 200) -and (Cell $e -500 500) -and (Cell $e 300 -40) -and (Cell $e -1000 -1000))
    Check '... not from an underground step, nor from somewhere you never were' (-not (Cell $e 500 -500) -and -not (Cell $e 1500 1500))
    $null = Post '/api/position' @{ x = 1200; y = 50; z = -1200; heading = 0; cave = $false; area = 0; world = 'world-e' }
    $null = Post '/api/position' @{ x = -1200; y = 50; z = 1200; heading = 0; cave = $true; area = 64; world = 'world-e' }
    $null = Post '/api/found' @{ ids = @(7002); found = $true; world = 'world-e' }
    $e = Explored
    Check 'a live step clears 50 m around you, but not underground' ((Cell $e 1200 -1200) -and (Cell $e 1240 -1200) -and -not (Cell $e 1270 -1200) -and -not (Cell $e -1200 1200))
    Check 'finding something in a cave does not clear the island' (-not (Cell $e 1000 1000))
    $n = Cells $e
    $null = Post '/api/trail/clear' @{ world = 'world-e' }
    Check 'clearing the trail keeps what you explored' ((Cells (Explored)) -eq $n)
    $r = Post '/api/explored/reset' @{ world = 'world-e' }
    Check 'Reset exploration puts the fog back' ($r.cleared -eq $n -and (Cells (Explored)) -eq 0)
    $r = Post '/api/explored/restore' @{ world = 'world-e' }
    Check '... and Undo brings it back' ($r.restored -eq $n -and (Cells (Explored)) -eq $n)
    Stop-Map
    $s = Start-Map $data $es
    Check 'it is saved, and not made again from history' ((Cells (World $s 'world-e').explored) -eq $n)
    $null = Post '/api/explored/reset' @{ world = 'world-e' }
    Stop-Map
    $s = Start-Map $data $es
    Check 'after a reset, starting the map again does not bring the old explored area back' ((Cells (World $s 'world-e').explored) -eq 0)
    Stop-Map

    Write-Host "`n17. The fog inside caves and bunkers"
    # a made-up cave: one corridor along z = -1450 from x = -1500 to -1400, with a floor at 10 m and one at 30 m
    # over it. Cell k (0..50) is the lower floor at x = -1500 + 2k, cell 51 + k the upper one above it.
    $cells = (@(0..50 | ForEach-Object { "[$(-1500 + 2 * $_),-1450,10]" }) + @(0..50 | ForEach-Object { "[$(-1500 + 2 * $_),-1450,30]" })) -join ','
    Set-Content (Join-Path $App 'web\data\underground.js') -Encoding utf8 -Value @('// test data',
        "window.SOTF_UNDERGROUND = [{`"id`":`"cave-t`",`"name`":`"Test cave`",`"kind`":`"cave`",`"cell`":2.0,`"bounds`":[-1500,-1450,-1400,-1450],`"y`":[10,30],`"cells`":[$cells]}];")
    Set-Content (Join-Path $App 'web\data\locations.js') -Encoding utf8 -Value @('// test data', 'window.SOTF_CATEGORIES = [];',
        'window.SOTF_LOCATIONS = [{"id":7003,"c":"tool","t":"In the test cave","x":-1420,"y":-1450,"g":["In a cave"],"a":"cave-t"}];')
    $us = Join-Path $T 'saves17'
    New-Save $us '3000000006' 'world-u' 0 0 '2026-01-09T10:00:00+00:00' @{
        'WorldObjectLocatorManagerSaveData.json' = Locators @((LocatorKey -1410.2 30.2 -1450.1)) # something broken on the upper floor
    }
    $data = Join-Path $T 'data17'
    Set-Json "$data\progress.json" ('{"worlds":{"world-u":{"found":[7003],"pins":[]}},"seenSaves":[],"trail":[' +
        '{"x":-1490,"y":-1450,"h":10,"t":100,"s":"live","w":"world-u","c":1}]}')
    function Bit($b64, [int]$k) { $b = [Convert]::FromBase64String($b64); [bool]($b[$k -shr 3] -band (1 -shl ($k -band 7))) }
    function Under { (World (Invoke-RestMethod "$Base/api/state") 'world-u').exploredUnder.'cave-t' }
    function IslandU { (World (Invoke-RestMethod "$Base/api/state") 'world-u').explored }
    $s = Start-Map $data $us
    $u = (World $s 'world-u').exploredUnder.'cave-t'
    Check 'the first time it comes from history: an underground trail step, on its own floor only' ((Bit $u 5) -and -not (Bit $u 56))
    Check '... what you found inside, around it' (Bit $u 40)
    Check '... and a changed object on the upper floor, there and not on the island above' ((Bit $u 95) -and -not (Cell (World $s 'world-u').explored -1410 -1450))
    $null = Post '/api/position' @{ x = -1460; y = 30; z = -1450; heading = 0; cave = $true; area = 2; world = 'world-u' }
    $u = Under
    Check 'underground, a live step clears about 15 m around you, on your floor' ((Bit $u 71) -and (Bit $u 78) -and -not (Bit $u 79) -and -not (Bit $u 20))
    $null = Post '/api/position' @{ x = -1436; y = 60; z = -1450; heading = 0; cave = $false; area = 0; world = 'world-u' }
    Check 'walking over the cave on the surface clears the island, not the cave under it' ((Cell (IslandU) -1436 -1450) -and -not (Bit (Under) 32) -and -not (Bit (Under) 83))
    $n = 0; foreach ($k in 0..101) { if (Bit (Under) $k) { $n++ } }
    $island = Cells (World (Invoke-RestMethod "$Base/api/state") 'world-u').explored
    $r = Post '/api/explored/reset' @{ world = 'world-u'; area = 'cave-t' }
    Check 'Reset exploration for one cave clears just that cave' ($r.cleared -eq $n -and -not (Bit (Under) 5) -and (Cells (World (Invoke-RestMethod "$Base/api/state") 'world-u').explored) -eq $island)
    $null = Post '/api/explored/restore' @{ world = 'world-u' }
    Check '... and Undo brings it back' ((Bit (Under) 5) -and (Bit (Under) 71))
    $null = Post '/api/explored/reset' @{ world = 'world-u' }
    Check 'Reset everything clears the island and the caves' (-not (Bit (Under) 5) -and (Cells (World (Invoke-RestMethod "$Base/api/state") 'world-u').explored) -eq 0)
    Stop-Map

    Write-Host "`n17b. A cave with a new outline (its real floor) keeps what you explored of the old one"
    $ugFile = Join-Path $App 'web\data\underground.js'
    $ugBefore = Get-Content $ugFile -Raw
    # the new outline: the corridor at z = -1450 again, and a passage beside it at z = -1448 (cell 2 i and 2 i + 1)
    $newCells = (@(0..50 | ForEach-Object { "[$(-1500 + 2 * $_),-1450,10],[$(-1500 + 2 * $_),-1448,10]" })) -join ','
    Set-Content $ugFile -Encoding utf8 -Value @('// test data',
        "window.SOTF_UNDERGROUND = [{`"id`":`"cave-t`",`"name`":`"Test cave`",`"kind`":`"cave`",`"cell`":2.0,`"v`":2,`"bounds`":[-1500,-1450,-1400,-1448],`"y`":[10,10],`"cells`":[$newCells]}];")
    Set-Content (Join-Path $App 'web\data\underground-v1.js') -Encoding utf8 -Value @('// test data', "window.SOTF_UNDERGROUND_V1 = {`"cave-t`":[$cells]};")
    $old = New-Object byte[] 13; $old[0] = 32 # old cell 5: (-1490, -1450) on the lower floor
    $data = Join-Path $T 'data17b'
    Set-Json "$data\progress.json" ('{"worlds":{"world-u":{"found":[],"pins":[],"explored":{"v":4,"upTo":0,"bits":"' + [Convert]::ToBase64String((New-Object byte[] 20000)) +
        '","under":{"cave-t":"' + [Convert]::ToBase64String($old) + '"}}}},"seenSaves":[],"trail":[]}')
    $s = Start-Map $data $us
    $u = (World $s 'world-u').exploredUnder.'cave-t'
    Check 'what you explored is carried over to the new cells around it (10 m)' ((Bit $u 10) -and (Bit $u 11) -and (Bit $u 18) -and -not (Bit $u 24) -and -not (Bit $u 25))
    Stop-Map
    Check '... and saved for the new outline' ((Read-Json "$data\progress.json").worlds.'world-u'.explored.underV.'cave-t' -eq 2)
    $s = Start-Map $data $us
    $u = (World $s 'world-u').exploredUnder.'cave-t'
    Check '... once: a restart keeps it as it is' ((Bit $u 10) -and (Bit $u 11) -and -not (Bit $u 24))
    Stop-Map
    Set-Content $ugFile -Encoding utf8 -NoNewline -Value $ugBefore
    Remove-Item (Join-Path $App 'web\data\underground-v1.js')

    Write-Host "`n18. Where the world started, and the way between the places of one stretch"
    Set-Content (Join-Path $App 'web\data\locations.js') -Encoding utf8 -Value @('// test data', 'window.SOTF_CATEGORIES = [];',
        'window.SOTF_LOCATIONS = [{"id":2,"c":"spawn","t":"Ocean Crash Site","x":500,"y":500}];')
    $rs = Join-Path $T 'saves18'
    New-Save $rs '3000000007' 'world-r' 0 0 '2026-01-10T10:00:00+00:00' @{
        'GameStateSaveData.json' = Wrap 'GameState' @{ SaveTime = '2026-01-10T10:00:00+00:00'; GameDays = 3; GameType = 'Normal'; CrashSite = 'ocean' }
        # one stretch: two felled trees 200 m apart (linked), and two 600 m apart (too far to link)
        'WorldObjectLocatorManagerSaveData.json' = Locators @((LocatorKey 100 50 0), (LocatorKey 300 50 0), (LocatorKey 1000 50 -1000), (LocatorKey 1600 50 -1000))
    }
    $s = Start-Map (Join-Path $T 'data18') $rs
    $w = World $s 'world-r'
    Check 'the world remembers its crash site' ($w.history.crashSite -eq 'ocean')
    Check 'about 120 m around it is explored' ((Cell $w.explored 500 500) -and (Cell $w.explored 600 500) -and -not (Cell $w.explored 650 500))
    Check 'places of one stretch up to 450 m apart are linked by a corridor' (Cell $w.explored 200 0)
    Check '... further apart they are not' (-not (Cell $w.explored 1300 -1000))
    Stop-Map

    Write-Host "`n19. Vehicles you moved, the crash site, the fog brush, Virginia, and a rebuild that keeps what was explored"
    Set-Content (Join-Path $App 'web\data\locations.js') -Encoding utf8 -Value @('// test data', 'window.SOTF_CATEGORIES = [];',
        'window.SOTF_LOCATIONS = [{"id":2,"c":"spawn","t":"Ocean Crash Site","x":-1500,"y":1500}];')
    function Vehicles($list) { Wrap 'WorldItemManager' @{ WorldItemStates = @($list | ForEach-Object { @{ ObjectNameId = $_[0]; ItemId = $_[1]; Position = @{ x = $_[2]; y = 50; z = $_[3] }; Rotation = @{ x = 0; y = 0; z = 0 } } }) } }
    $vs = Join-Path $T 'saves19'
    New-Save $vs '3000000008' 'world-v' 0 0 '2026-01-11T10:00:00+00:00' @{
        'GameStateSaveData.json' = Wrap 'GameState' @{ SaveTime = '2026-01-11T10:00:00+00:00'; GameDays = 3; GameType = 'Normal'; CrashSite = 'ocean' }
        'WorldItemManagerSaveData.json' = Vehicles (@(, @('World.GolfCart.01', 0, -1000, 1000)) + @(, @('World.KnightV.01', 630, 800, -800)))
    }
    New-Save $vs '3000000009' 'world-v' 0 0 '2026-01-12T10:00:00+00:00' @{
        'GameStateSaveData.json' = Wrap 'GameState' @{ SaveTime = '2026-01-12T10:00:00+00:00'; GameDays = 4; GameType = 'Normal'; CrashSite = 'ocean' }
        # the cart driven away, the Knight V settled half a metre, a glider put down
        'WorldItemManagerSaveData.json' = Vehicles (@(, @('World.GolfCart.01', 0, 400, 400)) + @(, @('World.KnightV.01', 630, 800.5, -800)) + @(, @('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', 626, -300, 900)))
        # Virginia has come to see you twice
        'SaveData.json' = Wrap 'VailWorldSim' @{ WorldEventData = @{ WorldEventTypeStats = @(@{ Name = 'Virginia Short'; RunCount = 1 }, @{ Name = 'Virginia Long'; RunCount = 1 }, @{ Name = 'Chopper'; RunCount = 3 }) } }
    }
    $data = Join-Path $T 'data19'
    # an earlier build's grid with one cell nothing in history explains (its trail was reset since), and a cave cell
    $old = New-Object byte[] 20000; $k = 30 * 400 + 370; $old[$k -shr 3] = [byte](1 -shl ($k -band 7)) # the cell at (1700, -1700)
    $oldUnder = [Convert]::ToBase64String([byte[]](@([byte]1) + (New-Object byte[] 12)))
    Set-Json "$data\progress.json" ('{"worlds":{"world-v":{"found":[],"pins":[],"explored":{"v":3,"upTo":0,"bits":"' + [Convert]::ToBase64String($old) +
        '","under":{"cave-t":"' + $oldUnder + '"}}}},"seenSaves":[],"trail":[]}')
    $s = Start-Map $data $vs
    $w = World $s 'world-v'
    Check 'a rebuild keeps what was explored before, on the island and in caves' ((Cell $w.explored 1700 -1700) -and (Bit $w.exploredUnder.'cave-t' 0))
    Check 'a golf cart you moved: where it stood and where you left it' ((Cell $w.explored -1000 1000) -and (Cell $w.explored 400 400))
    Check '... a vehicle that only settled says nothing' (-not (Cell $w.explored 800 -800))
    Check '... and a glider you put down is where you were' (Cell $w.explored -300 900)
    Check 'they come with the save they were seen in, apart from what you changed' (@($w.history.changed).Count -eq 1 -and @($w.history.changed[0].p).Count -eq 0 -and @($w.history.changed[0].v).Count -eq 9)
    Check 'the crash site is cleared, and not joined to the rest by a guess' ((Cell $w.explored -1500 1500) -and -not (Cell $w.explored -1250 1250))
    Check 'the save says how often Virginia came to see you' ($w.history.virginia -eq 2)
    Check 'every save of the world is listed, newest first, with where you were' (@($w.saveList).Count -eq 2 -and $w.saveList[0].time -gt $w.saveList[1].time -and $w.saveList[0].day -eq 4 -and $w.saveList[0].world -eq 'world-v')
    $r = Post '/api/explored/paint' @{ world = 'world-v'; cells = @((90 * 400 + 30), (90 * 400 + 31)); on = $true } # (-1700, -1100) and (-1690, -1100)
    Check 'the fog brush clears cells' ($r.changed -eq 2 -and (Cell (World (Invoke-RestMethod "$Base/api/state") 'world-v').explored -1700 -1100))
    $r = Post '/api/explored/paint' @{ world = 'world-v'; cells = @((90 * 400 + 30), (30 * 400 + 370)); on = $false }
    $e = (World (Invoke-RestMethod "$Base/api/state") 'world-v').explored
    Check '... and puts the fog back' ($r.changed -eq 2 -and -not (Cell $e -1700 -1100) -and (Cell $e -1690 -1100) -and -not (Cell $e 1700 -1700))
    $bad = try { Post '/api/explored/paint' @{ world = 'world-v'; cells = @(160000) } | Out-Null; $false } catch { $true }
    Check '... and refuses cells off the grid' $bad
    Stop-Map
    $p = (Read-Json "$data\progress.json").worlds.'world-v'.explored
    $saved = [Convert]::ToBase64String([Convert]::FromBase64String($p.bits))
    Check 'what the brush did is saved, and the grid as the current version (4)' ((Cell $saved -1690 -1100) -and -not (Cell $saved -1700 -1100) -and $p.v -eq 4)
    # an earlier progress file next to the app (a backup from before an older build lost some fog): its cells come back
    $more = New-Object byte[] 20000; $k = 40 * 400 + 360; $more[$k -shr 3] = [byte](1 -shl ($k -band 7)) # the cell at (1600, -1600)
    $import = Join-Path $App 'import\progress.json'
    Set-Json $import ('{"worlds":{"world-v":{"found":[],"pins":[],"explored":{"v":2,"bits":"' + [Convert]::ToBase64String($more) +
        '","under":{"cave-t":"' + [Convert]::ToBase64String([byte[]](@([byte]2) + (New-Object byte[] 12))) + '"}}}},"trail":[]}')
    $s = Start-Map $data $vs
    $w = World $s 'world-v'
    Check 'an earlier progress file adds what it had explored, on the island and in caves' ((Cell $w.explored 1600 -1600) -and (Cell $w.explored -1690 -1100) -and (Bit $w.exploredUnder.'cave-t' 1) -and (Bit $w.exploredUnder.'cave-t' 0))
    Stop-Map
    Check '... once' (@((Read-Json "$data\progress.json").imported | Where-Object { $_ -like 'explored:*' }).Count -eq 1)
    Remove-Item $import -Force

    Write-Host "`n20. Picking an item up, live, marks its spot found"
    Set-Content (Join-Path $App 'web\data\locations.js') -Encoding utf8 -Value @('// test data', 'window.SOTF_CATEGORIES = [];',
        ('window.SOTF_LOCATIONS = [{"id":9001,"c":"tool","t":"A tool","x":100,"y":100},{"id":9002,"c":"tool","t":"The same tool","x":300,"y":100},' +
         '{"id":9003,"c":"tool","t":"A tool in the cave","x":-1490,"y":-1450,"g":["In a cave"],"a":"cave-t"}];'))
    Set-Content (Join-Path $App 'web\data\items.js') -Encoding utf8 -Value @('// test data', 'window.SOTF_ITEMS = {"9001":501,"9002":501,"9003":502};')
    $data = Join-Path $T 'data20'
    Set-Json "$data\progress.json" '{"worlds":{"world-p":{"found":[],"pins":[]}},"seenSaves":[],"trail":[]}'
    $s = Start-Map $data $noSaves
    function Got([double]$x, [double]$h, [double]$z, $cave, $items) { Post '/api/position' @{ x = $x; y = $h; z = $z; heading = 0; cave = $cave; area = 0; world = 'world-p'; got = $items } | Out-Null }
    function FoundP { @((World (Invoke-RestMethod "$Base/api/state") 'world-p').found) }
    Got 103 10 100 $false @(, @(501, 1))
    Check 'an item you pick up marks its spot right there found' ((FoundP) -contains 9001 -and -not ((FoundP) -contains 9002))
    Got 150 10 100 $false @(, @(501, 1))
    Check '... one with no spot within a few metres marks nothing (crafted, or from a box)' ((FoundP).Count -eq 1)
    Got -1490 30 -1450 $true @(, @(502, 1))
    Check '... in a cave, not on another floor' (-not ((FoundP) -contains 9003))
    Got -1491 10.5 -1450 $true @(, @(502, 1))
    Check '... but on your floor' ((FoundP) -contains 9003)
    Got 300 10 100 $true @(, @(501, 1))
    Check '... and not on the island while you are underground' (-not ((FoundP) -contains 9002))
    Stop-Map
    Check '... and it is saved' (@((Read-Json "$data\progress.json").worlds.'world-p'.found).Count -eq 2)
    Remove-Item (Join-Path $App 'web\data\items.js')

    Write-Host "`n16b. An explored area from an earlier build is made again from history"
    $data = Join-Path $T 'data16b'
    $zeros = [Convert]::ToBase64String((New-Object byte[] 20000))
    Set-Json "$data\progress.json" ('{"worlds":{"world-e":{"found":[],"pins":[],"explored":{"v":1,"upTo":0,"bits":"' + $zeros + '"}}},"seenSaves":[],"trail":[]}')
    $s = Start-Map $data $es
    Check 'made again from the saves (version 1 had smaller circles)' (Cell (World $s 'world-e').explored 100 200)
    Stop-Map
    Check '... and saved as the current version (4)' ((Read-Json "$data\progress.json").worlds.'world-e'.explored.v -eq 4)
}
finally {
    Stop-Map
    Remove-Item $T -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:failures) { Write-Host "$($script:failures) check(s) failed." -ForegroundColor Red }
else { Write-Host 'All upgrade checks passed.' -ForegroundColor Green }
exit $script:failures
