<#
  SOTF Live Map installer. Start it with Install.bat (or Uninstall.bat), not directly.

  install.ps1 [-GameDir <path>] [-Uninstall] [-Yes] [-Sandbox <folder>]
    -GameDir    Sons of the Forest folder (found through Steam if left out)
    -Uninstall  remove the mod and the map (your progress is kept unless you say otherwise)
    -Yes        answer every question with its default (for unattended installs)
    -Sandbox    for tests: change nothing outside -GameDir and this folder (no game check, no closing a
                running map, the shortcut and progress folders go under it, no firewall change)

  Upgrades from earlier versions (when the map was called SOTF Field Map): the new files go in first, then
  the old ones are removed; the settings, the desktop shortcut and (when you agree) the firewall permission
  for phones move over. Your progress folder is moved by the map itself on its first start (MapServer.cs).
#>
param([string]$GameDir, [switch]$Uninstall, [switch]$Yes, [string]$Sandbox)

$ErrorActionPreference = 'Stop'
$AppId = 1326470
$MelonVersion = '0.7.3'
$MelonUrl = "https://github.com/LavaGang/MelonLoader/releases/download/v$MelonVersion/MelonLoader.x64.zip"
$MelonSha256 = '5b2b2f3d1cd42b59ec886c5bdc2663edae87a0097a4f4a8f58c0965a99dda416'
$Package = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$Name = 'SOTF Live Map'
$ModDll = 'SOTFLiveMap.dll'
$AppFolder = 'SOTFLiveMap'
$AppExe = 'SOTF Live Map.exe'
$LocalDir = if ($Sandbox) { Join-Path $Sandbox 'Local' } else { $env:LOCALAPPDATA }
$DesktopDir = if ($Sandbox) { Join-Path $Sandbox 'Desktop' } else { [Environment]::GetFolderPath('Desktop') }
$DataDir = Join-Path $LocalDir $Name
$Shortcut = Join-Path $DesktopDir "$Name.lnk"
# what earlier versions installed
$OldModFiles = 'SOTFFieldMap.dll', 'LiveMapPosition.dll', 'LiveMapPosition'
$OldAppFolder = 'FieldMap'
$OldDataDir = Join-Path $LocalDir 'SOTF Field Map'
$OldShortcut = Join-Path $DesktopDir 'SOTF Field Map.lnk'

function Say($text, $color = 'Gray') { Write-Host "  $text" -ForegroundColor $color }
function Step($text) { Write-Host ''; Write-Host "  $text" -ForegroundColor Cyan }
function Ask($question, $default = 'Y') {
    if ($Yes) { return $default -eq 'Y' }
    $hint = if ($default -eq 'Y') { '[Y/n]' } else { '[y/N]' }
    $answer = Read-Host "  $question $hint"
    if ([string]::IsNullOrWhiteSpace($answer)) { $answer = $default }
    return $answer.Trim().ToUpper().StartsWith('Y')
}
function Fail($text) { Write-Host ''; Write-Host "  $text" -ForegroundColor Red; exit 1 }
function Remove-IfThere($path) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force; Say "Removed $path" }
}

# ---------- find the game ----------
function Find-Game {
    $steam = $null
    foreach ($key in 'HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'HKLM:\SOFTWARE\Valve\Steam') {
        $props = Get-ItemProperty $key -ErrorAction SilentlyContinue
        if ($props.SteamPath) { $steam = $props.SteamPath; break }
        if ($props.InstallPath) { $steam = $props.InstallPath; break }
    }
    if (-not $steam) { return $null }
    $libraries = @($steam)
    $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
        foreach ($m in (Select-String -Path $vdf -Pattern '"path"\s+"(.+?)"')) {
            $libraries += ($m.Matches[0].Groups[1].Value -replace '\\\\', '\')
        }
    }
    foreach ($lib in ($libraries | Select-Object -Unique)) {
        $acf = Join-Path $lib "steamapps\appmanifest_$AppId.acf"
        if (-not (Test-Path $acf)) { continue }
        $dir = (Select-String -Path $acf -Pattern '"installdir"\s+"(.+?)"').Matches[0].Groups[1].Value
        $path = Join-Path $lib "steamapps\common\$dir"
        if (Test-Path (Join-Path $path 'SonsOfTheForest.exe')) { return (Resolve-Path $path).Path }
    }
    return $null
}

function Pick-Game {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Select your Sons Of The Forest folder (the one with SonsOfTheForest.exe)'
    if ($dialog.ShowDialog() -ne 'OK') { return $null }
    if (Test-Path (Join-Path $dialog.SelectedPath 'SonsOfTheForest.exe')) { return $dialog.SelectedPath }
    return $null
}

Write-Host ''
Write-Host "  $Name" -ForegroundColor White
Write-Host '  Live position, waypoints and progress tracking for Sons of the Forest' -ForegroundColor DarkGray

if (-not $GameDir) { $GameDir = Find-Game }
if (-not $GameDir -or -not (Test-Path (Join-Path $GameDir 'SonsOfTheForest.exe'))) {
    Say 'Could not find Sons of the Forest through Steam. Please select the game folder.' Yellow
    if ($Yes) { Fail 'No game folder given. Run again with -GameDir "<path>".' }
    $GameDir = Pick-Game
    if (-not $GameDir) { Fail 'That folder does not contain SonsOfTheForest.exe. Nothing was changed.' }
}
Say "Game folder: $GameDir" Green

if (-not $Sandbox -and (Get-Process SonsOfTheForest -ErrorAction SilentlyContinue)) {
    Fail 'Sons of the Forest is running. Close the game, then run this again. Nothing was changed.'
}

$ModsDir = Join-Path $GameDir 'Mods'
$AppDir = Join-Path $GameDir $AppFolder
$PrefsFile = Join-Path $GameDir 'UserData\MelonPreferences.cfg'

function Stop-Map {
    # Ask a running map to write its progress first, then stop it (this version or an earlier one).
    if ($Sandbox) { return }
    try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8765/api/found' -ContentType 'application/json' -Body '{"ids":[],"found":true}' -TimeoutSec 3 | Out-Null } catch { }
    $procs = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq $AppExe -or $_.Name -eq 'FieldMap.exe' -or ($_.Name -match '^pythonw?\.exe$' -and $_.CommandLine -match 'server\.py')
    })
    foreach ($p in $procs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Say "Closed the running map ($($p.Name))."
    }
    if ($procs.Count) { Start-Sleep -Seconds 1 }
}

# ---------- settings: [FieldMap] (and [LiveMapPosition], the first version) become [LiveMap] ----------
function Read-Prefs {
    $sections = [ordered]@{ '' = New-Object Collections.Generic.List[string] }
    if (-not (Test-Path $PrefsFile)) { return $sections }
    $current = ''
    foreach ($line in [IO.File]::ReadAllLines($PrefsFile)) {
        if ($line -match '^\s*\[([^\]]+)\]\s*$') {
            $current = $Matches[1].Trim()
            if (-not $sections.Contains($current)) { $sections[$current] = New-Object Collections.Generic.List[string] }
        } else {
            $sections[$current].Add($line)
        }
    }
    return $sections
}
function Get-Pref($sections, $section, $key) {
    if (-not $sections.Contains($section)) { return $null }
    foreach ($line in $sections[$section]) { if ($line -match "^\s*$key\s*=\s*(.*?)\s*$") { return $Matches[1] } }
    return $null
}
function Move-Prefs {
    $sections = Read-Prefs
    $old = @('FieldMap', 'LiveMapPosition') | Where-Object { $sections.Contains($_) }
    if (-not $old) { return }
    $carry = [ordered]@{}
    foreach ($key in 'Port', 'AutoStartMap', 'ShowGuide', 'GuideKey') {
        $v = Get-Pref $sections 'FieldMap' $key
        if ($null -ne $v) { $carry[$key] = $v }
    }
    $mapExe = Get-Pref $sections 'FieldMap' 'MapExe' # a map program of your own stays; the old default doesn't
    if ($mapExe -and $mapExe -notmatch '^(""|'''')$' -and $mapExe -notmatch 'FieldMap\.exe') { $carry['MapExe'] = $mapExe }
    $url = Get-Pref $sections 'LiveMapPosition' 'MapUrl'
    if (-not $carry.Contains('Port') -and $url -match ':(\d+)/') { $carry['Port'] = $Matches[1] }
    $auto = Get-Pref $sections 'LiveMapPosition' 'AutoStartMap'
    if (-not $carry.Contains('AutoStartMap') -and $null -ne $auto) { $carry['AutoStartMap'] = $auto }

    if (-not $sections.Contains('LiveMap')) { $sections['LiveMap'] = New-Object Collections.Generic.List[string] }
    foreach ($key in $carry.Keys) {
        if ($null -eq (Get-Pref $sections 'LiveMap' $key)) { $sections['LiveMap'].Add("$key = $($carry[$key])") }
    }
    $backup = "$PrefsFile.before-live-map-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
    Copy-Item -LiteralPath $PrefsFile $backup
    $out = New-Object Collections.Generic.List[string]
    foreach ($name in $sections.Keys) {
        if ($old -contains $name) { continue }
        if ($name -ne '') {
            if ($out.Count -and $out[$out.Count - 1].Trim()) { $out.Add('') }
            $out.Add("[$name]")
        }
        foreach ($line in $sections[$name]) { $out.Add($line) }
    }
    [IO.File]::WriteAllLines($PrefsFile, $out) # UTF-8 without BOM, like MelonLoader writes it
    $moved = if ($carry.Count) { ($carry.Keys -join ', ') } else { 'nothing to keep' }
    Say "Settings moved to [LiveMap] in UserData\MelonPreferences.cfg ($moved). Backup: $(Split-Path $backup -Leaf)"
}

# ---------- phone access: the firewall permission Windows gave the old FieldMap.exe ----------
function Move-FirewallRule {
    if ($Sandbox) { return }
    $oldExe = Join-Path $GameDir "$OldAppFolder\FieldMap.exe"
    $newExe = Join-Path $AppDir $AppExe
    try { $filters = @(Get-NetFirewallApplicationFilter -ErrorAction Stop | Where-Object { $_.Program -ieq $oldExe }) } catch { return }
    if (-not $filters.Count) { return }
    Step 'Phone access (Windows Firewall)'
    Say 'Windows lets your phone reach the old FieldMap.exe. The map is now SOTF Live Map.exe.'
    $later = 'Not changed. The first time the map starts, Windows asks once: click Allow, or your phone cannot reach it.'
    if ($Yes) { Say "$later (An unattended install doesn't ask for administrator permission.)" Yellow; return }
    if (-not (Ask 'Move that permission to SOTF Live Map.exe? Windows asks for administrator permission.' 'Y')) { Say $later Yellow; return }
    $q = { param($s) "'" + $s.Replace("'", "''") + "'" }
    $script = "`$ErrorActionPreference = 'Stop'; Get-NetFirewallApplicationFilter | Where-Object { `$_.Program -ieq $(& $q $oldExe) } | ForEach-Object { " +
              "`$rule = `$_ | Get-NetFirewallRule; Set-NetFirewallApplicationFilter -InputObject `$_ -Program $(& $q $newExe); " +
              "Set-NetFirewallRule -Name `$rule.Name -NewDisplayName 'SOTF Live Map' }"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    try {
        $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile', '-EncodedCommand', $encoded
        if ($p.ExitCode -eq 0) { Say 'Your phone can reach SOTF Live Map.exe.' Green } else { Say $later Yellow }
    } catch {
        Say $later Yellow
    }
}

# ---------- uninstall ----------
if ($Uninstall) {
    Step "Removing $Name"
    Stop-Map
    foreach ($f in @($ModDll) + $OldModFiles) { Remove-IfThere (Join-Path $ModsDir $f) }
    Remove-IfThere $AppDir
    Remove-IfThere (Join-Path $GameDir $OldAppFolder)
    Remove-IfThere $Shortcut
    Remove-IfThere $OldShortcut
    $otherMods = @(Get-ChildItem $ModsDir -Filter *.dll -ErrorAction SilentlyContinue)
    if ((Test-Path (Join-Path $GameDir 'MelonLoader')) -and $otherMods.Count -eq 0 -and (Ask 'Also remove MelonLoader (no other mods are installed)?' 'Y')) {
        foreach ($item in 'MelonLoader', 'Mods', 'Plugins', 'UserData', 'UserLibs', 'version.dll', 'dobby.dll', 'NOTICE.txt') {
            Remove-IfThere (Join-Path $GameDir $item)
        }
    }
    $data = @($DataDir, $OldDataDir) | Where-Object { Test-Path $_ }
    if ($data -and (Ask "Delete your map progress too ($($data -join ', '))?" 'N')) {
        foreach ($d in $data) { Remove-Item -LiteralPath $d -Recurse -Force }
        Say 'Progress deleted.'
    }
    Step 'Done. The game itself was not changed.'
    exit 0
}

# ---------- RedLoader can't run next to MelonLoader ----------
$doorstop = Join-Path $GameDir 'doorstop_config.ini'
if ((Test-Path (Join-Path $GameDir '_Redloader')) -or ((Test-Path $doorstop) -and (Select-String -Path $doorstop -Pattern 'Redloader' -Quiet))) {
    Step 'RedLoader found'
    Say 'RedLoader and MelonLoader both load through version.dll, so only one can be installed.' Yellow
    if (-not (Ask 'Move RedLoader to a backup folder (_RedLoader_disabled) so MelonLoader can be used?' 'Y')) {
        Fail 'Nothing was changed.'
    }
    $backup = Join-Path $GameDir '_RedLoader_disabled'
    New-Item -ItemType Directory -Force $backup | Out-Null
    foreach ($item in '_Redloader', 'version.dll', 'doorstop_config.ini', 'Mods') {
        $path = Join-Path $GameDir $item
        if (Test-Path $path) { Move-Item $path (Join-Path $backup $item) -Force; Say "Moved $item to _RedLoader_disabled" }
    }
}

# ---------- .NET 6 (MelonLoader and the map both need it) ----------
Step 'Checking .NET 6'
$dotnetRoots = @("$env:ProgramFiles\dotnet", "${env:ProgramFiles(x86)}\dotnet") | Where-Object { $_ }
$hasNet6 = $false
foreach ($root in $dotnetRoots) {
    if (Get-ChildItem (Join-Path $root 'shared\Microsoft.NETCore.App') -Directory -Filter '6.*' -ErrorAction SilentlyContinue) { $hasNet6 = $true }
}
if ($hasNet6) {
    Say '.NET 6 runtime found.' Green
} else {
    Say 'The .NET 6 runtime is needed (by MelonLoader and by the map).' Yellow
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget -and (Ask 'Install it now with winget (Microsoft.DotNet.Runtime.6)?' 'Y')) {
        & winget install --id Microsoft.DotNet.Runtime.6 -e --source winget --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { Fail 'Installing .NET 6 failed. Install it from https://dotnet.microsoft.com/download/dotnet/6.0 and run this again.' }
    } else {
        Start-Process 'https://dotnet.microsoft.com/download/dotnet/6.0'
        Fail 'Install the .NET 6 Runtime (x64) from the page that just opened, then run this again.'
    }
}

# ---------- MelonLoader ----------
Step "Checking MelonLoader $MelonVersion"
$melonDll = Join-Path $GameDir 'MelonLoader\net6\MelonLoader.dll'
$installMelon = $true
if ((Test-Path $melonDll) -and (Test-Path (Join-Path $GameDir 'version.dll'))) {
    $have = (Get-Item $melonDll).VersionInfo.ProductVersion
    Say "MelonLoader $have is installed." Green
    $installMelon = $false
}
if ($installMelon) {
    $zip = Join-Path $env:TEMP "MelonLoader-$MelonVersion.x64.zip"
    Say "Downloading MelonLoader $MelonVersion from GitHub (LavaGang/MelonLoader)..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $MelonUrl -OutFile $zip -UseBasicParsing
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $MelonSha256) { Remove-Item $zip -Force; Fail "The download doesn't match MelonLoader's published checksum. Nothing was installed." }
    Expand-Archive -Path $zip -DestinationPath $GameDir -Force
    Remove-Item $zip -Force
    Say 'MelonLoader installed.' Green
}

# ---------- the mod and the map ----------
Step "Installing $Name"
Stop-Map

# Progress of the old Python map (its folder is in the settings of the first version), found before the old
# settings and files are cleaned up below.
$legacy = @()
$m = Get-Pref (Read-Prefs) 'LiveMapPosition' 'MapFolder'
if ($m -match '^[''"](.+)[''"]$') { $legacy += [IO.Path]::Combine($Matches[1], 'progress.json') }
$legacy += Join-Path $Package 'progress.json'
$legacy += Join-Path $GameDir "$OldAppFolder\import\progress.json"

New-Item -ItemType Directory -Force $ModsDir | Out-Null
Copy-Item (Join-Path $Package "Mods\$ModDll") $ModsDir -Force
Say "Mod: $ModsDir\$ModDll"
if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
Copy-Item (Join-Path $Package $AppFolder) $AppDir -Recurse -Force
Say "Map: $AppDir\$AppExe"

# Put next to the map, not in %LOCALAPPDATA%: started from a packaged app (Windows Store, MSIX), this script's
# new files there are redirected into that app's private folder, where the map never sees them.
# The map imports it on its next start when your progress has no found markers or pins yet (see MapServer.cs).
foreach ($candidate in $legacy) {
    if (Test-Path -LiteralPath $candidate) {
        New-Item -ItemType Directory -Force (Join-Path $AppDir 'import') | Out-Null
        Copy-Item -LiteralPath $candidate (Join-Path $AppDir 'import\progress.json') -Force
        Say "Found progress from the old Python map ($candidate). The map imports it on its next start, unless it already has found markers or pins." Green
        break
    }
}

# the earlier version's files, now that the new ones are in place
$hadOld = (Test-Path (Join-Path $GameDir $OldAppFolder)) -or ($OldModFiles | Where-Object { Test-Path (Join-Path $ModsDir $_) })
if ($hadOld) { Step 'Removing the earlier version (SOTF Field Map)' }
foreach ($f in $OldModFiles) { Remove-IfThere (Join-Path $ModsDir $f) }
Remove-IfThere (Join-Path $GameDir $OldAppFolder)
Move-Prefs
if (Test-Path $OldDataDir) { Say "Your progress in $OldDataDir moves to $DataDir when the map starts." }

# ---------- desktop shortcut ----------
Remove-IfThere $OldShortcut
New-Item -ItemType Directory -Force $DesktopDir | Out-Null
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($Shortcut)
$link.TargetPath = Join-Path $AppDir $AppExe
$link.WorkingDirectory = $AppDir
$link.IconLocation = (Join-Path $GameDir 'SonsOfTheForest.exe') + ',0'
$link.Description = "Open the $Name"
$link.Save()
Say "Desktop shortcut: $Name"

Move-FirewallRule

Step 'Done!'
Say 'Start Sons of the Forest as you normally do. The map opens by itself in your browser.'
if ($installMelon) {
    Say 'The first start with MelonLoader takes a few extra minutes (it prepares the game files once).' Yellow
}
Say 'Phone: same Wi-Fi as this PC, then "Open on phone" in the map menu. When Windows asks,'
Say "allow $AppExe, otherwise the phone cannot reach it."
Say "Your progress is kept in $DataDir"
exit 0
