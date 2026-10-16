<#
  Update test for the map app: what it asks GitHub, what it shows, and what Update installs.

    powershell -ExecutionPolicy Bypass -File tools\test_update.ps1 [-Port 8797] [-FakePort 8796]

  Publishes "SOTF Live Map.exe" into a dummy game folder in %TEMP% and points it at a fake GitHub on a spare
  local port that serves made-up release JSON and zips. Nothing is sent to GitHub, and the made-up release's
  installer only writes a note in the dummy game folder (and closes the map, like the real one), so neither
  your game nor your progress is touched. "The game" is a renamed copy of ping.exe.
  Exit code: the number of failed checks.
#>
param([int]$Port = 8797, [int]$FakePort = 8796)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$T = Join-Path ([IO.Path]::GetTempPath()) ('livemap-update-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Game = Join-Path $T 'game'
$MapExe = Join-Path $Game 'SOTFLiveMap\SOTF Live Map.exe'
$Base = "http://127.0.0.1:$Port"
$Fake = "http://127.0.0.1:$FakePort"
$Www = Join-Path $T 'www'           # what the fake GitHub serves
$Requests = Join-Path $T 'requests.log'
$Repo = 'test/live-map'
$GameProcess = 'FakeSotfGame'
$Data = Join-Path $T 'data'
$Saves = Join-Path $T 'saves'
. (Join-Path $PSScriptRoot 'testlib.ps1')
$script:CheckUpdates = $true # Start-Map: don't add --no-update-check

[xml]$proj = Get-Content (Join-Path $Root 'src\LiveMap.App\LiveMap.App.csproj')
$Current = $proj.Project.PropertyGroup.Version | Select-Object -First 1
$Cfg = Join-Path $Game 'UserData\MelonPreferences.cfg'
$CfgOn = "[LiveMap]`nPort = $Port`nAutoStartMap = true`nCheckForUpdates = true`n"

# ---------- the fake GitHub ----------
$serverScript = {
    param($port, $www, $log)
    Set-Content -LiteralPath "$log.pid" $PID # Stop-Job can't interrupt AcceptTcpClient: the test stops this process
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    $listener.Start()
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $reader = New-Object IO.StreamReader($stream)
            $first = $reader.ReadLine()
            if ($first) { # (an empty connection is the test checking that this server is up)
                $path = ($first -split ' ')[1]
                $agent = ''
                while ($line = $reader.ReadLine()) { if ($line -match '^User-Agent:\s*(.*)$') { $agent = $Matches[1] } }
                Add-Content -LiteralPath $log -Value "$path|$agent"
                $file = Join-Path $www ($path.Split('?')[0].TrimStart('/') -replace '/', '\')
                if (Test-Path -LiteralPath $file -PathType Leaf) { $body = [IO.File]::ReadAllBytes($file); $status = '200 OK' }
                else { $body = [Text.Encoding]::UTF8.GetBytes('{"message":"Not Found"}'); $status = '404 Not Found' }
                $head = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status`r`nContent-Type: application/octet-stream`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
                $stream.Write($head, 0, $head.Length)
                $stream.Write($body, 0, $body.Length)
                $stream.Flush()
            }
        } catch { } finally { $client.Close() }
    }
}

# A made-up release package: the real layout, with an installer that only notes how it was run.
function New-Package($version, [int]$exitCode = 0) {
    $pkg = Join-Path $T "pkg-$version-$exitCode"
    New-Item -ItemType Directory -Force "$pkg\installer", "$pkg\Mods", "$pkg\SOTFLiveMap" | Out-Null
    Set-Content -LiteralPath "$pkg\Mods\SOTFLiveMap.dll" 'dummy mod'
    Set-Content -LiteralPath "$pkg\SOTFLiveMap\SOTF Live Map.exe" 'dummy map'
    Set-Content -LiteralPath "$pkg\Install.bat" 'dummy'
    $installer = @'
param([string]$GameDir, [switch]$Yes, [switch]$Uninstall, [string]$Sandbox)
Set-Content -LiteralPath (Join-Path $GameDir 'installed.txt') "Yes=$Yes GameDir=$GameDir From=$PSScriptRoot"
Write-Host 'fake installer ran'
if (EXITCODE -ne 0) { exit EXITCODE }
# like the real installer: close the running map before replacing it
$port = [int](Get-Content -LiteralPath (Join-Path $GameDir 'test-port.txt'))
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
exit 0
'@
    Set-Content -LiteralPath "$pkg\installer\install.ps1" ($installer -replace 'EXITCODE', $exitCode)
    $dir = Join-Path $Www "test\live-map\releases\download\v$version"
    New-Item -ItemType Directory -Force $dir | Out-Null
    $zip = Join-Path $dir "SOTF-Live-Map-$version.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
    try {
        foreach ($f in (Get-ChildItem $pkg -Recurse -File)) {
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $f.FullName.Substring($pkg.Length + 1).Replace('\', '/'))
        }
    } finally { $archive.Dispose() }
    $sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    Set-Content -LiteralPath "$zip.sha256" "$sha  SOTF-Live-Map-$version.zip" -Encoding ascii
    return @{ Version = $version; Name = "SOTF-Live-Map-$version.zip"; Url = "$Fake/test/live-map/releases/download/v$version/SOTF-Live-Map-$version.zip"; Sha = $sha; Size = (Get-Item $zip).Length }
}

# The release JSON GitHub answers with (the fields the map reads).
function Set-Release($tag, $assets, [string]$body = "## What's new`n- **Faster** map`n- Fixes", [switch]$Prerelease) {
    $json = @{ tag_name = $tag; name = "SOTF Live Map $tag"; body = $body; draft = $false; prerelease = [bool]$Prerelease
               html_url = "https://github.com/$Repo/releases/tag/$tag"; published_at = '2026-10-16T10:00:00Z'; assets = @($assets) }
    Set-Json (Join-Path $Www 'repos\test\live-map\releases\latest') ($json | ConvertTo-Json -Depth 5)
}
function Zip-Asset($pkg, [string]$digest = 'right', [string]$url) {
    $a = @{ name = $pkg.Name; size = $pkg.Size; browser_download_url = $(if ($url) { $url } else { $pkg.Url }) }
    if ($digest -eq 'right') { $a.digest = "sha256:$($pkg.Sha)" } elseif ($digest -ne 'none') { $a.digest = $digest }
    return $a
}
function Sha-Asset($pkg) { @{ name = "$($pkg.Name).sha256"; size = 90; browser_download_url = "$($pkg.Url).sha256" } }

function Requests { if (Test-Path $Requests) { @(Get-Content -LiteralPath $Requests) } else { @() } }
function Clear-Requests { if (Test-Path $Requests) { Clear-Content -LiteralPath $Requests } }
function Status { Invoke-RestMethod "$Base/api/update" -TimeoutSec 5 }
function Wait-For([scriptblock]$condition, [int]$seconds = 15) {
    $until = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $until) {
        try { if (& $condition) { return $true } } catch { }
        Start-Sleep -Milliseconds 250
    }
    return $false
}
function Runners { @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like "*$T*run-update.ps1*" }) }
function Map-Pid { (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }
function Stop-All {
    Runners | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } # it would start the map again
    Stop-Map
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Get-Process -Name $GameProcess -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
function Start-Updating([string[]]$extra = @()) {
    Clear-Requests
    $s = Start-Map $Data $Saves 20 (@('--update-repo', $Repo, '--update-api', $Fake, '--game-process', $GameProcess) + $extra)
    return $s
}
function Wait-Checked { Wait-For { (Status).checked } 10 }
function Post-Update($body) {
    try { return Invoke-RestMethod -Method Post "$Base/api/update" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 30 }
    catch { return [pscustomobject]@{ status = [int]$_.Exception.Response.StatusCode } }
}
function Wait-Phase($phase, [int]$seconds = 20) { Wait-For { (Status).phase -eq $phase } $seconds }

$fakeServer = $null
try {
    foreach ($p in $Port, $FakePort) {
        if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { throw "port $p is in use; pass -Port / -FakePort" }
    }
    Write-Host "Publishing the map app into a dummy game folder: $Game"
    & dotnet publish (Join-Path $Root 'src\LiveMap.App\LiveMap.App.csproj') -c Release -nologo -v q -o (Join-Path $Game 'SOTFLiveMap')
    if ($LASTEXITCODE -ne 0) { throw 'publish failed' }
    New-Item -ItemType Directory -Force (Join-Path $Game 'SOTFLiveMap\web'), (Join-Path $Game 'UserData'), $Saves, $Www | Out-Null
    Set-Content -LiteralPath (Join-Path $Game 'SonsOfTheForest.exe') 'dummy'
    Set-Content -LiteralPath (Join-Path $Game 'test-port.txt') $Port
    Set-Json $Cfg $CfgOn
    New-Save $Saves '1000000001' 'world-a' 100 200 '2026-01-01T10:00:00+00:00'
    Copy-Item C:\Windows\System32\PING.EXE (Join-Path $T "$GameProcess.exe")
    New-Item -ItemType File -Force $Requests | Out-Null
    $fakeServer = Start-Job -ScriptBlock $serverScript -ArgumentList $FakePort, $Www, $Requests
    if (-not (Wait-For { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $FakePort); $c.Dispose(); $true } 15)) { throw 'the fake GitHub did not start' }

    $new = New-Package '9.9.0'
    Set-Release 'v9.9.0' @((Zip-Asset $new))

    Write-Host "`n1. A build without a repo never asks"
    Clear-Requests
    $s = Start-Map $Data $Saves 20 @('--update-repo', '""', '--update-api', $Fake, '--game-process', $GameProcess)
    Start-Sleep -Seconds 4
    $u = Status
    Check "the map says its version ($Current)" ($s.info.version -eq $Current -and $u.version -eq $Current)
    Check 'no repo, so update checks are off' ($null -eq $u.repo -and -not $u.on)
    Check 'nothing was sent' ((Requests).Count -eq 0)
    Check '"Check now" is refused' ((Post-Update @{ action = 'check' }).status -eq 400)
    Stop-All

    Write-Host "`n2. A newer release: one request, shown with its notes, nothing downloaded"
    $null = Start-Updating
    Check 'it checks at start' (Wait-Checked)
    $u = Status
    Check 'update 9.9.0 is offered' ($u.latest.version -eq '9.9.0' -and $u.on -and $u.phase -eq 'idle')
    Check 'with its notes and release page' ($u.latest.notes -match 'Faster' -and $u.latest.url -eq "https://github.com/$Repo/releases/tag/v9.9.0")
    Check 'it can be installed from here (the map is in the game folder)' ($u.latest.installable -and $u.canInstall)
    $r = @(Requests)
    $okOne = $r.Count -eq 1 -and $r[0] -eq "/repos/$Repo/releases/latest|SOTF-Live-Map/$Current"
    Check "exactly one request: the latest release, as SOTF-Live-Map/$Current$(if (-not $okOne) { ' (got: ' + ($r -join '; ') + ')' })" $okOne
    $u = Post-Update @{ action = 'check' }
    Check '"Check now" asks once more' ((Requests).Count -eq 2 -and $u.latest.version -eq '9.9.0')

    Write-Host "`n3. Off on the page"
    $u = Post-Update @{ action = 'setting'; on = $false }
    Check 'switched off: nothing offered' (-not $u.on -and -not $u.pageOn -and $null -eq $u.latest)
    Check 'the switch is saved' ((Read-Json "$Data\settings.json").checkForUpdates -eq $false)
    Stop-All
    $null = Start-Updating
    Start-Sleep -Seconds 4
    Check 'after a restart it stays off and sends nothing' (-not (Status).on -and (Requests).Count -eq 0)
    $u = Post-Update @{ action = 'setting'; on = $true }
    Check 'switched on again: it checks straight away' ((Wait-For { (Requests).Count -eq 1 -and (Status).latest.version -eq '9.9.0' } 10))
    Stop-All

    Write-Host "`n4. Off in MelonPreferences.cfg, or with --no-update-check"
    Set-Json $Cfg ($CfgOn -replace 'CheckForUpdates = true', 'CheckForUpdates = false')
    $null = Start-Updating
    Start-Sleep -Seconds 4
    $u = Status
    Check 'CheckForUpdates = false: off, and the page says why' (-not $u.on -and $u.prefOff -and $u.pageOn)
    Check '... and nothing was sent' ((Requests).Count -eq 0)
    Stop-All
    Set-Json $Cfg $CfgOn
    $null = Start-Updating @('--no-update-check')
    Start-Sleep -Seconds 4
    $u = Status
    Check '--no-update-check: off, nothing sent' (-not $u.on -and $u.cmdOff -and (Requests).Count -eq 0)
    Stop-All

    Write-Host "`n5. Releases that are not newer, or not for everyone"
    foreach ($case in @(@{ tag = "v$Current"; what = 'the same version' }, @{ tag = 'v1.0.0'; what = 'an older version' },
                         @{ tag = 'v9.9.0'; what = 'a pre-release'; pre = $true }, @{ tag = 'nightly'; what = 'a tag that is no version' })) {
        Set-Release $case.tag @((Zip-Asset $new)) -Prerelease:([bool]$case.pre)
        $null = Start-Updating
        $ok = Wait-Checked
        $u = Status
        Check "$($case.what) ($($case.tag)) is not offered" ($ok -and $null -eq $u.latest -and -not $u.error)
        Stop-All
    }
    Remove-Item (Join-Path $Www 'repos\test\live-map\releases\latest')
    $null = Start-Updating
    $ok = Wait-Checked
    Check 'no release at all yet (404): nothing offered, no error' ($ok -and $null -eq (Status).latest -and -not (Status).error)
    Stop-All

    Write-Host "`n6. A zip somewhere else than the release is never downloaded"
    Set-Release 'v9.9.0' @((Zip-Asset $new -url 'http://example.invalid/SOTF-Live-Map-9.9.0.zip'))
    $null = Start-Updating
    $null = Wait-Checked
    $u = Status
    Check 'the update is shown, but not installable from the map' ($u.latest.version -eq '9.9.0' -and -not $u.latest.installable)
    Check 'Update is refused' ((Post-Update @{ action = 'install' }).status -eq 400)
    Stop-All

    Write-Host "`n7. A download that doesn't match the SHA-256 is not installed"
    Set-Release 'v9.9.0' @((Zip-Asset $new -digest ('sha256:' + ('0' * 64))))
    $null = Start-Updating
    $null = Wait-Checked
    $null = Post-Update @{ action = 'install' }
    Check 'it fails with the SHA-256 message' ((Wait-Phase 'failed') -and (Status).message -match 'SHA-256')
    Check 'the installer did not run, the zip is deleted' (-not (Test-Path "$Game\installed.txt") -and -not (Test-Path "$Data\updates\9.9.0\$($new.Name)"))
    Stop-All

    Write-Host "`n8. A release without a SHA-256 is not installed"
    Set-Release 'v9.9.0' @((Zip-Asset $new -digest 'none')) 'No checksum here.'
    $null = Start-Updating
    $null = Wait-Checked
    $null = Post-Update @{ action = 'install' }
    Check 'it fails: the release publishes no SHA-256' ((Wait-Phase 'failed') -and (Status).message -match "doesn't publish a SHA-256")
    Check 'the installer did not run' (-not (Test-Path "$Game\installed.txt"))
    Stop-All

    Write-Host "`n9. Update while the game runs: waits for the game, installs, starts the map again"
    Set-Release 'v9.9.0' @((Zip-Asset $new -digest 'none'), (Sha-Asset $new)) # the SHA-256 from the .sha256 file
    $fakeGame = Start-Process (Join-Path $T "$GameProcess.exe") -ArgumentList '-n', '600', '127.0.0.1' -PassThru -WindowStyle Hidden
    $null = Start-Updating
    $null = Wait-Checked
    $oldPid = Map-Pid
    $u = Post-Update @{ action = 'install' }
    Check 'Update starts the download' ($u.phase -eq 'downloading')
    Check 'downloaded and checked: now it waits for the game' ((Wait-Phase 'waiting') -and (Status).gameRunning)
    Check 'the zip and its .sha256 came from the release' (@(Requests | Where-Object { $_ -like "/test/live-map/releases/download/v9.9.0/$($new.Name)*" }).Count -eq 2)
    Start-Sleep -Seconds 5
    Check 'nothing is installed while the game runs' (-not (Test-Path "$Game\installed.txt") -and (Map-Pid) -eq $oldPid)
    Stop-Process -Id $fakeGame.Id -Force
    Check 'the game closed: the installer runs' (Wait-For { Test-Path "$Game\installed.txt" } 20)
    $note = Get-Content "$Game\installed.txt" -Raw
    Check 'as install.ps1 -Yes -GameDir <game>, from the download' ($note -match 'Yes=True' -and $note -match ([regex]::Escape("GameDir=$Game ")) -and $note -match ([regex]::Escape("$Data\updates\9.9.0\package\installer")))
    Check 'the map starts again by itself (same port, same data)' (Wait-For { (Map-Pid) -and (Map-Pid) -ne $oldPid -and (Status).updated.ok } 30)
    $u = Status
    Check 'the page is told: updated to 9.9.0' ($u.updated.to -eq '9.9.0' -and $u.updated.from -eq $Current -and $u.phase -eq 'idle')
    Check 'the installer log is kept, the result is read once' ((Get-Content $u.updated.log -Raw) -match 'exit code: 0' -and -not (Test-Path "$Data\updates\result.json"))
    Check 'the restarted map does not open a browser tab' ((Get-CimInstance Win32_Process -Filter "ProcessId = $(Map-Pid)").CommandLine -match '--no-open')
    Stop-All
    Remove-Item "$Game\installed.txt"

    Write-Host "`n10. Update with the game closed, SHA-256 from the release notes: installs right away"
    Set-Release 'v9.9.0' @((Zip-Asset $new -digest 'none')) "Fixes.`n`nSHA-256 ($($new.Name)): $($new.Sha)"
    $null = Start-Updating
    $null = Wait-Checked
    $null = Post-Update @{ action = 'install' }
    Check 'installed without waiting' (Wait-For { Test-Path "$Game\installed.txt" } 20)
    Check 'and the map is back' (Wait-For { (Status).updated.ok } 30)
    Stop-All
    Remove-Item "$Game\installed.txt"

    Write-Host "`n11. An installer that fails"
    $bad = New-Package '9.9.1' 3
    Set-Release 'v9.9.1' @((Zip-Asset $bad))
    $null = Start-Updating
    $null = Wait-Checked
    $mapPid = Map-Pid
    $null = Post-Update @{ action = 'install' }
    Check 'the same map tells the page it did not finish' (Wait-For { $u = Status; $u.updated -and -not $u.updated.ok } 30)
    $u = Status
    Check 'with the exit code and the log' ($u.updated.code -eq 3 -and $u.updated.to -eq '9.9.1' -and (Test-Path $u.updated.log) -and (Map-Pid) -eq $mapPid)
    Check 'and it still offers the update' ($u.latest.version -eq '9.9.1' -and $u.phase -eq 'idle')
    $runnerDone = Wait-For { (Runners).Count -eq 0 } 20
    Start-Sleep -Seconds 2 # the second map it started sees the port taken and quits
    $maps = @(Get-CimInstance Win32_Process -Filter "Name = 'SOTF Live Map.exe'" | Where-Object { $_.CommandLine -like "*$Data*" })
    $okOne = $runnerDone -and (Map-Pid) -eq $mapPid -and $maps.Count -eq 1
    Check "starting the map again leaves this one running (only one map)$(if (-not $okOne) { " (runner done: $runnerDone, map $(Map-Pid) was $mapPid, maps: $($maps.ProcessId -join ','))" })" $okOne
    Stop-All
}
finally {
    Stop-All
    if ($fakeServer) {
        if (Test-Path "$Requests.pid") { Stop-Process -Id ([int](Get-Content "$Requests.pid")) -Force -ErrorAction SilentlyContinue }
        Remove-Job $fakeServer -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    Remove-Item $T -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:failures) { Write-Host "$($script:failures) check(s) failed." -ForegroundColor Red }
else { Write-Host 'All update checks passed.' -ForegroundColor Green }
exit $script:failures
