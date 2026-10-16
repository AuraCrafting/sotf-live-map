<#
  Makes a release in one command: version, tests, zip, notes and SHA-256, commit and tag.

    powershell -ExecutionPolicy Bypass -File build\publish.ps1 -Version 3.3.0 [-Notes <notes.md>] [-GameDir <path>] [-Publish]

  1. Sets the version in src\LiveMap.App\LiveMap.App.csproj, src\LiveMap.Mod\LiveMap.Mod.csproj and the MelonInfo
     in src\LiveMap.Mod\LiveMapMod.cs.
  2. Runs tools\test_upgrade.ps1 and tools\test_update.ps1, then build\release.ps1, then tools\test_install.ps1
     against the new package (it installs from the package, so it runs after the build). Stops at the first
     failure and puts the version back; nothing is committed then.
  3. Writes dist\SOTF-Live-Map-<version>.zip.sha256 and dist\SOTF-Live-Map-<version>-notes.md: your notes
     (-Notes, Markdown) or else the commit messages since the last tag, how to install, and the SHA-256.
  4. Commits the version change ("SOTF Live Map <version>") and tags it v<version>.
  5. Only with -Publish: pushes the commit and the tag to origin and runs gh release create (GitHub CLI) with
     the zip, its .sha256 and the notes, on the repo in UpdateRepo (LiveMap.App.csproj), the one the map checks.

  It builds on this PC on purpose: the mod compiles against the Il2Cpp assemblies MelonLoader generates from your
  copy of the game, which a CI server doesn't have. Needs a clean working tree (commit your changes first).
#>
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Notes,
    [string]$GameDir,
    [switch]$Publish
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$AppProj = Join-Path $Root 'src\LiveMap.App\LiveMap.App.csproj'
$ModProj = Join-Path $Root 'src\LiveMap.Mod\LiveMap.Mod.csproj'
$ModMain = Join-Path $Root 'src\LiveMap.Mod\LiveMapMod.cs'
$VersionFiles = $AppProj, $ModProj, $ModMain
$Tag = "v$Version"
$Name = "SOTF-Live-Map-$Version"
$Zip = Join-Path $Root "dist\$Name.zip"
$ShaFile = "$Zip.sha256"
$NotesFile = Join-Path $Root "dist\$Name-notes.md"

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
# (git writes progress to stderr, which Windows PowerShell turns into errors under 'Stop': go by the exit code)
function Invoke-Git { $ErrorActionPreference = 'Continue'; & git.exe -C $Root @args; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed" } }
function Read-Git { $ErrorActionPreference = 'Continue'; $out = & git.exe -C $Root @args 2>$null; if ($LASTEXITCODE -ne 0) { return $null }; return $out }
function Write-Text($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false))) }
function Run-Test($script, [string[]]$extra = @()) {
    Step "tools\$script"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "tools\$script") @extra
    if ($LASTEXITCODE -ne 0) { throw "tools\$script failed ($LASTEXITCODE failed check(s))" }
}

# ---------- before anything changes ----------
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 3.3.0 (got '$Version')" }
if (-not (Read-Git rev-parse --is-inside-work-tree)) { throw "$Root is not a git repository" }
if (Read-Git status --porcelain) { throw 'The working tree has changes. Commit them first, so the release is exactly what the tag says.' }
if (Read-Git tag --list $Tag) { throw "Tag $Tag exists already" }
if (-not (Read-Git config user.name) -or -not (Read-Git config user.email)) { throw 'Set your git name and e-mail first: git config user.name "..." and git config user.email "..."' }
if ($Notes -and -not (Test-Path -LiteralPath $Notes)) { throw "Notes file not found: $Notes" }
[xml]$proj = Get-Content $AppProj
$repo = "$($proj.Project.PropertyGroup.UpdateRepo)".Trim()
$old = "$($proj.Project.PropertyGroup.Version | Select-Object -First 1)".Trim()
if ([version]$Version -lt [version]$old) { throw "Version $Version is older than the current $old" }
if ($Publish) {
    if (-not $repo) { throw 'Set UpdateRepo (owner/name) in src\LiveMap.App\LiveMap.App.csproj first: the map checks that repo for updates.' }
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI not found. Install it (winget install GitHub.cli) and run gh auth login.' }
    $ErrorActionPreference = 'Continue'; & gh auth status *> $null; $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI is not logged in: run gh auth login' }
    if (-not (Read-Git remote get-url origin)) { throw "No git remote 'origin'. Add it: git remote add origin https://github.com/$repo.git" }
}
if (-not $repo) { Write-Host "Note: UpdateRepo is empty in LiveMap.App.csproj, so this build never checks for updates." -ForegroundColor Yellow }

$changed = $false
try {
    # ---------- 1. version ----------
    Step "Version $old -> $Version"
    foreach ($p in $AppProj, $ModProj) {
        $text = [IO.File]::ReadAllText($p)
        $new = [regex]::Replace($text, '<Version>[^<]*</Version>', "<Version>$Version</Version>")
        if ($new -eq $text -and $text -notmatch "<Version>$([regex]::Escape($Version))</Version>") { throw "No <Version> in $p" }
        Write-Text $p $new
    }
    $text = [IO.File]::ReadAllText($ModMain)
    $pattern = '(MelonInfo\(typeof\(LiveMapMod\),\s*"[^"]*",\s*")[^"]*(")'
    if ($text -notmatch $pattern) { throw "No MelonInfo in $ModMain" }
    Write-Text $ModMain ([regex]::Replace($text, $pattern, "`${1}$Version`${2}"))
    $changed = $true

    # ---------- 2. tests and the build ----------
    Run-Test 'test_upgrade.ps1'
    Run-Test 'test_update.ps1'
    Step 'build\release.ps1'
    $releaseArgs = @()
    if ($GameDir) { $releaseArgs = @('-GameDir', $GameDir) }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'build\release.ps1') @releaseArgs
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Zip)) { throw 'build\release.ps1 failed' }
    Run-Test 'test_install.ps1' @('-Package', (Join-Path $Root "dist\$Name"))

    # ---------- 3. SHA-256 and release notes ----------
    Step 'Release notes and SHA-256'
    $sha = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()
    Write-Text $ShaFile "$sha  $Name.zip`n"
    if ($Notes) {
        $what = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Notes)).Trim()
    } else {
        $last = Read-Git describe --tags --abbrev=0 --match 'v*'
        $range = if ($last) { "$last..HEAD" } else { 'HEAD' }
        $lines = @(Read-Git log --no-merges --pretty=format:'- %s' $range | Where-Object { $_ -notmatch '^- SOTF Live Map \d' })
        $what = "## What's new`n`n" + $(if ($lines) { $lines -join "`n" } else { '- Small fixes' })
    }
    $body = @"
$what

## Install or update

Download **$Name.zip**, unzip it anywhere and double-click **Install.bat**. Updating over an earlier version
keeps your progress and settings. A map that already checks for updates offers this one itself: press
**Update** in the map menu, and it installs once you close the game.

Needs Sons of the Forest (Steam, Windows) and MelonLoader 0.7.x; the installer gets MelonLoader 0.7.3 if you
don't have it.

SHA-256 ($Name.zip): $sha
"@
    Write-Text $NotesFile ($body.Replace("`r`n", "`n"))
    Write-Host "  $ShaFile"
    Write-Host "  $NotesFile"

    # ---------- 4. commit and tag ----------
    Step "Commit and tag $Tag"
    Invoke-Git add -- @($VersionFiles | ForEach-Object { $_.Substring($Root.Length + 1) })
    if (Read-Git diff --cached --name-only) { Invoke-Git commit -q -m "SOTF Live Map $Version" } else { Write-Host '  (version unchanged: nothing to commit)' }
    $changed = $false
    Invoke-Git tag -a $Tag -m "SOTF Live Map $Version"
    Write-Host "  Tagged $Tag at $(Read-Git rev-parse --short HEAD)"
}
catch {
    if ($changed) {
        Write-Host ''
        Write-Host "Stopped: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host 'Putting the version back; nothing was committed.' -ForegroundColor Yellow
        & git -C $Root checkout -- @($VersionFiles | ForEach-Object { $_.Substring($Root.Length + 1) })
    }
    throw
}

# ---------- 5. GitHub (only when asked) ----------
if (-not $Publish) {
    Step 'Done (not published)'
    Write-Host "  $Zip"
    Write-Host '  To publish this tag: push it and create the release, or run this again next time with -Publish.'
    Write-Host "    git push origin HEAD $Tag"
    Write-Host "    gh release create $Tag `"$Zip`" `"$ShaFile`" --repo <owner/name> --title `"SOTF Live Map $Version`" --notes-file `"$NotesFile`" --verify-tag"
    exit 0
}
Step "Publishing $Tag to github.com/$repo"
Invoke-Git push origin HEAD
Invoke-Git push origin $Tag
& gh release create $Tag $Zip $ShaFile --repo $repo --title "SOTF Live Map $Version" --notes-file $NotesFile --verify-tag
if ($LASTEXITCODE -ne 0) { throw 'gh release create failed (the tag is pushed; run the gh command again)' }
Write-Host "  https://github.com/$repo/releases/tag/$Tag" -ForegroundColor Green
