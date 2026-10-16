using System.Diagnostics;
using LiveMap;

// SOTF Live Map: double-click to open the map. The game mod also starts it when you launch the game.
//   "SOTF Live Map.exe" [--port 8765] [--local-only] [--no-open] [--data <folder for progress.json>] [--saves <save games folder>]
//                       [--no-update-check]
// For tools\test_update.ps1: [--update-repo owner/name] [--update-api <fake GitHub>] [--game-dir <folder>] [--game-process <name>]
var port = 8765;
var localOnly = false;
var open = true;
var noUpdateCheck = false;
string dataOverride = null, savesOverride = null, updateRepo = null, updateApi = null, gameDirOverride = null, gameProcess = null;
for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--port" when i + 1 < args.Length && int.TryParse(args[i + 1], out var p): port = p; i++; break;
        case "--local-only": localOnly = true; break;
        case "--no-open": open = false; break;
        case "--data" when i + 1 < args.Length: dataOverride = args[++i]; break;
        case "--saves" when i + 1 < args.Length: savesOverride = args[++i]; break;
        case "--no-update-check": noUpdateCheck = true; break;
        case "--update-repo" when i + 1 < args.Length: updateRepo = args[++i]; break;
        case "--update-api" when i + 1 < args.Length: updateApi = args[++i]; break;
        case "--game-dir" when i + 1 < args.Length: gameDirOverride = args[++i]; break;
        case "--game-process" when i + 1 < args.Length: gameProcess = args[++i]; break;
    }
}

Console.Title = "SOTF Live Map";
var baseDir = AppContext.BaseDirectory;
var web = Path.Combine(baseDir, "web");
if (!Directory.Exists(web)) // running from the source tree: src/LiveMap.App/bin/... -> repo/web
    web = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", "..", "web"));
var dataDir = Path.GetFullPath(dataOverride ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SOTF Live Map"));
// earlier versions kept it in "SOTF Field Map" next to it
var oldDataDir = Path.Combine(Path.GetDirectoryName(dataDir.TrimEnd(Path.DirectorySeparatorChar)) ?? dataDir, Upgrade.OldFolderName);
var saves = savesOverride ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData", "LocalLow", "Endnight", "SonsOfTheForest", "Saves");

// progress from an earlier version, put here by the installer (see MapServer.ImportEarlierProgress)
var importFile = Path.Combine(baseDir, "import", "progress.json");

var server = new MapServer(web, dataDir, saves, port, localOnly, importFile);
if (!server.CanListen())
{
    Console.WriteLine($"\n  The map is already running (port {port} is in use). Opening it in your browser.\n");
    if (open)
        OpenBrowser(server.LocalUrl);
    return;
}
Upgrade.MoveDataFolder(oldDataDir, dataDir); // only once this copy is the one that runs
server.Start();

// Installed by Install.bat, the map sits in <game>\SOTFLiveMap: only then can it update itself.
var gameDir = gameDirOverride ?? Path.GetDirectoryName(baseDir.TrimEnd(Path.DirectorySeparatorChar));
if (gameDir == null || !File.Exists(Path.Combine(gameDir, "SonsOfTheForest.exe")))
    gameDir = null;
var restartArgs = args.Contains("--no-open") ? args : args.Append("--no-open").ToArray(); // the page is open already
var updater = new Updater(updateRepo ?? Updater.BuiltInRepo, updateApi, gameDir, gameProcess, dataDir, port, noUpdateCheck, restartArgs,
    status => server.Publish("update", status));
server.Updater = updater;
updater.Start();

Console.WriteLine("\n  SOTF Live Map is running.\n");
Console.WriteLine($"  On this PC:   {server.LocalUrl}");
if (server.PhoneUrl is { } phone)
    Console.WriteLine($"  On your phone (same Wi-Fi): {phone}");
Console.WriteLine($"  Save games:   {(Directory.Exists(saves) ? "found" : "not found")} ({saves})");
Console.WriteLine($"  Your progress: {Path.Combine(dataDir, "progress.json")}");
Console.WriteLine("\n  Keep this window open while you play. Close it to stop the map.\n");
if (open)
    OpenBrowser(server.LocalUrl);

AppDomain.CurrentDomain.ProcessExit += (_, _) => server.Stop();
Console.CancelKeyPress += (_, e) => { server.Stop(); };
Thread.Sleep(Timeout.Infinite);

static void OpenBrowser(string url)
{
    try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose(); }
    catch (Exception) { /* no browser registered: the URL is printed above */ }
}
