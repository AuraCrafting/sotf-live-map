<#
  Builds the release zip: dist\SOTF-Live-Map-<version>.zip

  powershell -ExecutionPolicy Bypass -File build\release.ps1 [-GameDir <path>]

  Needs the .NET SDK (6 or newer) and Sons of the Forest with MelonLoader started at least once
  (the mod is compiled against the Il2Cpp assemblies MelonLoader generates).
#>
param([string]$GameDir)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $GameDir) {
    $steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath
    $libs = @($steam)
    $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) { foreach ($m in (Select-String -Path $vdf -Pattern '"path"\s+"(.+?)"')) { $libs += ($m.Matches[0].Groups[1].Value -replace '\\\\', '\') } }
    foreach ($lib in $libs) {
        $p = Join-Path $lib 'steamapps\common\Sons Of The Forest'
        if (Test-Path (Join-Path $p 'SonsOfTheForest.exe')) { $GameDir = $p; break }
    }
}
if (-not (Test-Path (Join-Path $GameDir 'MelonLoader\Il2CppAssemblies\Il2CppSons.dll'))) {
    throw "Game with MelonLoader assemblies not found ('$GameDir'). Start the game once with MelonLoader, or pass -GameDir."
}

[xml]$proj = Get-Content (Join-Path $Root 'src\LiveMap.App\LiveMap.App.csproj')
$Version = $proj.Project.PropertyGroup.Version | Select-Object -First 1
$Name = "SOTF-Live-Map-$Version"
$Out = Join-Path $Root "dist\$Name"
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force "$Out\Mods", "$Out\installer" | Out-Null

Write-Host "Building mod against $GameDir"
& dotnet build (Join-Path $Root 'src\LiveMap.Mod\LiveMap.Mod.csproj') -c Release -nologo -v q "-p:GameDir=$GameDir"
if ($LASTEXITCODE -ne 0) { throw 'mod build failed' }
Copy-Item (Join-Path $Root 'src\LiveMap.Mod\bin\Release\net6.0\SOTFLiveMap.dll') "$Out\Mods\"

Write-Host 'Publishing the map app'
& dotnet publish (Join-Path $Root 'src\LiveMap.App\LiveMap.App.csproj') -c Release -nologo -v q -o "$Out\SOTFLiveMap"
if ($LASTEXITCODE -ne 0) { throw 'app publish failed' }
Copy-Item (Join-Path $Root 'web') "$Out\SOTFLiveMap\web" -Recurse

Copy-Item (Join-Path $Root 'installer\Install.bat'), (Join-Path $Root 'installer\Uninstall.bat') $Out
Copy-Item (Join-Path $Root 'installer\install.ps1') "$Out\installer\"
Copy-Item (Join-Path $Root 'README.md'), (Join-Path $Root 'LICENSE'), (Join-Path $Root 'THIRD_PARTY_NOTICES.md') $Out

$zip = Join-Path $Root "dist\$Name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
# Entries with forward slashes (Windows PowerShell's own zip helpers write backslashes, which other tools mishandle)
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$stream = [IO.File]::Open($zip, [IO.FileMode]::Create)
$archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
foreach ($file in (Get-ChildItem $Out -Recurse -File)) {
    $entry = $file.FullName.Substring($Out.Length + 1).Replace('\', '/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entry, [IO.Compression.CompressionLevel]::Optimal)
}
$archive.Dispose()
$stream.Dispose()
Write-Host "Release: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"
