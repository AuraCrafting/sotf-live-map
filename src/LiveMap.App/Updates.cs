using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace LiveMap;

/// <summary>
/// Looks for a newer release on GitHub: once at start and then every few hours, one GET of
/// api.github.com/repos/&lt;repo&gt;/releases/latest (it sends nothing about you or your game). It never installs
/// by itself: the Update button on the map page downloads the release zip, checks it against the SHA-256 the
/// release publishes, and runs that release's own installer (install.ps1 -Yes) once the game is closed. The
/// installer keeps your progress and settings (see tools\test_install.ps1); the map starts again afterwards.
/// Off with CheckForUpdates = false under [LiveMap] in MelonPreferences.cfg, the switch on the map page, or
/// --no-update-check. A build without a repo (UpdateRepo in LiveMap.App.csproj) never checks.
/// </summary>
public sealed class Updater
{
    private static readonly TimeSpan Every = TimeSpan.FromHours(6); // also after a failed check (offline, GitHub busy)
    private static readonly TimeSpan FirstCheck = TimeSpan.FromSeconds(2);
    private const long MaxZip = 300L << 20;
    private const string DefaultApi = "https://api.github.com";

    public static readonly Version Current = Trim(typeof(Updater).Assembly.GetName().Version);
    /// <summary>The GitHub repo ("owner/name") this build looks at, from UpdateRepo in the project file.</summary>
    public static readonly string BuiltInRepo = typeof(Updater).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
        .FirstOrDefault(a => a.Key == "UpdateRepo")?.Value?.Trim() ?? "";

    private static readonly HttpClient Http = new(new SocketsHttpHandler
    {
        AutomaticDecompression = DecompressionMethods.All, ConnectTimeout = TimeSpan.FromSeconds(15),
    }) { Timeout = TimeSpan.FromMinutes(15) };

    private readonly object _lock = new();
    private readonly string _repo, _api, _gameDir, _gameProcess, _updates, _settingsPath;
    private readonly int _port;
    private readonly bool _cmdOff;
    private readonly string[] _restartArgs;
    private readonly Action<JsonNode> _publish;
    private Timer _timer, _watch;
    private string _lastWatched;
    private int _runnerPid;         // run-update.ps1, while it waits for the game or installs
    private bool _pageOff;         // the switch on the map page (settings.json)
    private Release _latest;        // newer than this version, else null
    private double? _checked;
    private string _checkError;
    private bool _checking;
    private string _phase = "idle"; // idle, downloading, waiting (for the game to close), installing, failed
    private string _message;
    private string _pendingTo;      // the version being installed
    private JsonObject _updated;    // what the last update did, read once at start

    private sealed record Release(Version Version, string Tag, string Name, string Notes, string Page, string Published,
        string ZipName, string ZipUrl, long ZipSize, string Digest, string ShaUrl);

    /// <param name="repo">"owner/name"; empty: no checks</param>
    /// <param name="api">GitHub's API (a fake one in tools\test_update.ps1)</param>
    /// <param name="gameDir">the game folder this map is installed in; null: it can't update itself (run from source)</param>
    /// <param name="restartArgs">the map's arguments, to start it again the same way after an update</param>
    public Updater(string repo, string api, string gameDir, string gameProcess, string dataDir, int port, bool cmdOff,
        string[] restartArgs, Action<JsonNode> publish)
    {
        _repo = Regex.IsMatch(repo ?? "", @"^[\w.-]+/[\w.-]+$") ? repo : "";
        _api = string.IsNullOrWhiteSpace(api) ? DefaultApi : api.TrimEnd('/');
        _gameDir = gameDir;
        _gameProcess = string.IsNullOrWhiteSpace(gameProcess) ? "SonsOfTheForest" : gameProcess;
        _updates = Path.Combine(dataDir, "updates");
        _settingsPath = Path.Combine(dataDir, "settings.json");
        _port = port;
        _cmdOff = cmdOff;
        _restartArgs = restartArgs;
        _publish = publish;
        try
        {
            if (File.Exists(_settingsPath) && JsonNode.Parse(File.ReadAllText(_settingsPath))?["checkForUpdates"] is JsonValue v && v.TryGetValue<bool>(out var on))
                _pageOff = !on;
        }
        catch (Exception)
        {
            // unreadable settings: keep the default (on)
        }
    }

    private bool PrefOff => ReadPref() == false;
    private bool On => !_cmdOff && _repo.Length > 0 && !_pageOff && !PrefOff;
    private bool CanInstall => _gameDir != null;
    private bool GameRunning() => Process.GetProcessesByName(_gameProcess).Length > 0;

    /// <summary>Picks up an update that was installed (or is still waiting for the game to close), then starts checking.</summary>
    public void Start()
    {
        Recover();
        _timer = new Timer(_ => Tick(), null, FirstCheck, Timeout.InfiniteTimeSpan);
        _watch = new Timer(_ => Watch(), null, TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(3));
    }

    private void Tick()
    {
        Check();
        _timer?.Change(Every, Timeout.InfiniteTimeSpan);
    }

    /// <summary>While an update waits or installs: tells the page when the game closes and when the installer is done.</summary>
    private void Watch()
    {
        lock (_lock)
            if (_phase != "waiting")
                return;
        var s = Status();
        var key = $"{s["phase"]}|{s["updated"]?.ToJsonString()}";
        if (key == _lastWatched)
            return;
        _lastWatched = key;
        _publish?.Invoke(s);
    }

    // ---------- what the page shows ----------

    public JsonObject Status()
    {
        lock (_lock)
        {
            if (_phase == "waiting")
                PickUpResult();
            var phase = _phase;
            var gameRunning = GameRunning();
            if (phase == "waiting" && !gameRunning)
                phase = "installing";
            var message = phase switch
            {
                "waiting" => $"Update {_pendingTo} is ready. It installs when you close the game, and the map starts again by itself.",
                "installing" => $"Installing {_pendingTo}. The map starts again by itself in a moment.",
                _ => _message,
            };
            JsonObject latest = null;
            if (_latest is { } r)
                latest = new JsonObject
                {
                    ["version"] = r.Version.ToString(3), ["name"] = r.Name, ["notes"] = r.Notes, ["url"] = r.Page,
                    ["published"] = r.Published, ["size"] = r.ZipSize, ["installable"] = r.ZipUrl != null && CanInstall,
                };
            return new JsonObject
            {
                ["version"] = Current.ToString(3),
                ["repo"] = _repo.Length > 0 ? _repo : null,
                ["on"] = On,
                ["pageOn"] = !_pageOff,
                ["prefOff"] = PrefOff,
                ["cmdOff"] = _cmdOff,
                ["canInstall"] = CanInstall,
                ["checked"] = _checked,
                ["checking"] = _checking,
                ["error"] = _checkError,
                ["latest"] = latest,
                ["phase"] = phase,
                ["message"] = message,
                ["gameRunning"] = gameRunning,
                ["updated"] = _updated?.Clone(),
            };
        }
    }

    private void Publish() => _publish?.Invoke(Status());

    /// <summary>POST /api/update: {"action": "check"}, {"action": "install"} or {"action": "setting", "on": bool}.</summary>
    public (int, JsonNode) Handle(JsonNode data)
    {
        switch (data?["action"]?.ToString())
        {
            case "check":
                if (!On)
                    return (400, new JsonObject { ["error"] = "update checks are off" });
                Check();
                return (200, Status());
            case "install":
                return Install();
            case "setting":
                if (data["on"] is not JsonValue v || !v.TryGetValue<bool>(out var on))
                    return (400, new JsonObject { ["error"] = "send on: true or false" });
                lock (_lock)
                {
                    _pageOff = !on;
                    if (!on)
                        _latest = null;
                }
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(_settingsPath)!);
                    File.WriteAllText(_settingsPath, new JsonObject { ["checkForUpdates"] = on }.ToJsonString());
                }
                catch (Exception e)
                {
                    return (500, new JsonObject { ["error"] = $"could not save the setting: {e.Message}" });
                }
                if (On)
                    Task.Run(Check);
                Publish();
                return (200, Status());
            default:
                return (400, new JsonObject { ["error"] = "unknown action" });
        }
    }

    // ---------- checking ----------

    /// <summary>One look at the latest release.</summary>
    private void Check()
    {
        if (!On)
            return;
        lock (_lock)
        {
            if (_checking)
                return;
            _checking = true;
        }
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{_api}/repos/{_repo}/releases/latest");
            req.Headers.UserAgent.ParseAdd($"SOTF-Live-Map/{Current.ToString(3)}");
            req.Headers.Accept.ParseAdd("application/vnd.github+json");
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            using var res = Http.Send(req, cts.Token);
            Release release = null;
            if (res.StatusCode != HttpStatusCode.NotFound) // 404: no release published yet
            {
                res.EnsureSuccessStatusCode();
                using var reader = new StreamReader(res.Content.ReadAsStream(cts.Token));
                release = ParseRelease(JsonNode.Parse(reader.ReadToEnd()));
            }
            lock (_lock)
            {
                _latest = release != null && release.Version > Current && On ? release : null;
                _checked = MapServer.Now();
                _checkError = null;
            }
        }
        catch (Exception e)
        {
            lock (_lock)
            {
                _checked = MapServer.Now();
                _checkError = e is OperationCanceledException ? "GitHub didn't answer in time" : Short(e.Message);
            }
        }
        finally
        {
            lock (_lock)
                _checking = false;
            Publish();
        }
    }

    private Release ParseRelease(JsonNode json)
    {
        if (json?["draft"]?.GetValue<bool>() == true || json?["prerelease"]?.GetValue<bool>() == true)
            return null;
        var tag = json?["tag_name"]?.ToString() ?? "";
        var m = Regex.Match(tag, @"^v?(\d+)\.(\d+)(?:\.(\d+))?$");
        if (!m.Success)
            return null;
        var version = new Version(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), m.Groups[3].Success ? int.Parse(m.Groups[3].Value) : 0);
        var assets = json["assets"] as JsonArray ?? new JsonArray();
        JsonNode zip = assets.FirstOrDefault(a => a?["name"]?.ToString() == $"SOTF-Live-Map-{version.ToString(3)}.zip")
                       ?? assets.FirstOrDefault(a => a?["name"]?.ToString() is { } n && n.StartsWith("SOTF-Live-Map-") && n.EndsWith(".zip"));
        var zipName = zip?["name"]?.ToString();
        var zipUrl = zip?["browser_download_url"]?.ToString();
        var sha = zipName == null ? null : assets.FirstOrDefault(a => a?["name"]?.ToString() == zipName + ".sha256")?["browser_download_url"]?.ToString();
        var digest = zip?["digest"]?.ToString() is { } d && Regex.Match(d, "^sha256:([0-9a-fA-F]{64})$") is { Success: true } dm ? dm.Groups[1].Value : null;
        var page = json["html_url"]?.ToString();
        return new Release(version, tag, Clip(json["name"]?.ToString() ?? tag, 200), Clip(json["body"]?.ToString() ?? "", 20000),
            page != null && page.StartsWith("http") ? page : null, json["published_at"]?.ToString(),
            zipName, Allowed(zipUrl) ? zipUrl : null, zip?["size"] is JsonValue s && s.TryGetValue<long>(out var size) ? size : 0,
            digest, Allowed(sha) ? sha : null);
    }

    /// <summary>Downloads only from this repo's releases on GitHub (or from the fake API's own address in tests).</summary>
    private bool Allowed(string url)
    {
        if (string.IsNullOrEmpty(url) || !Uri.TryCreate(url, UriKind.Absolute, out var u))
            return false;
        if (_api == DefaultApi)
            return url.StartsWith($"https://github.com/{_repo}/releases/download/", StringComparison.OrdinalIgnoreCase);
        var api = new Uri(_api);
        return u.Scheme == api.Scheme && u.Host == api.Host && u.Port == api.Port;
    }

    // ---------- installing ----------

    private (int, JsonNode) Install()
    {
        Release release;
        lock (_lock)
        {
            if (!CanInstall)
                return (400, new JsonObject { ["error"] = "this copy of the map isn't in the game folder, so it can't update itself" });
            if (_phase is "downloading" or "waiting" or "installing")
                return (200, Status());
            if (_latest?.ZipUrl == null)
                return (400, new JsonObject { ["error"] = "there is no update to install" });
            release = _latest;
            _phase = "downloading";
            _pendingTo = release.Version.ToString(3);
            _message = $"Downloading {_pendingTo}…";
        }
        Publish();
        Task.Run(() => RunInstall(release));
        return (200, Status());
    }

    private void RunInstall(Release r)
    {
        var to = r.Version.ToString(3);
        try
        {
            var dir = Path.Combine(_updates, to);
            if (Directory.Exists(dir))
                Directory.Delete(dir, true);
            Directory.CreateDirectory(dir);
            var zip = Path.Combine(dir, Path.GetFileName(r.ZipName));
            Download(r.ZipUrl, zip, to);

            SetMessage($"Checking the download of {to}…");
            var expected = r.Digest ?? ShaFile(r.ShaUrl) ?? ShaInNotes(r.Notes, r.ZipName);
            if (expected == null)
                throw new UpdateFailed($"The release doesn't publish a SHA-256 for {r.ZipName}, so it wasn't installed. Download it from the release page instead.");
            string actual;
            using (var f = File.OpenRead(zip))
            using (var sha = SHA256.Create())
                actual = Convert.ToHexString(sha.ComputeHash(f));
            if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(zip);
                throw new UpdateFailed("The download doesn't match the SHA-256 of the release. Nothing was installed.");
            }

            var package = Path.Combine(dir, "package");
            ZipFile.ExtractToDirectory(zip, package); // refuses entries that point outside the folder
            var installer = Path.Combine(package, "installer", "install.ps1");
            if (!File.Exists(installer) || !File.Exists(Path.Combine(package, "Mods", "SOTFLiveMap.dll")) ||
                !File.Exists(Path.Combine(package, "SOTFLiveMap", "SOTF Live Map.exe")))
                throw new UpdateFailed("The download isn't a SOTF Live Map release (no installer in it). Nothing was installed.");

            var runner = Path.Combine(dir, "run-update.ps1");
            File.WriteAllText(runner, RunnerScript);
            var job = Path.Combine(dir, "job.json");
            var args = new JsonArray();
            foreach (var a in _restartArgs)
                args.Add(a);
            File.WriteAllText(job, new JsonObject
            {
                ["from"] = Current.ToString(3), ["to"] = to, ["installer"] = installer, ["gameDir"] = _gameDir,
                ["gameProcess"] = _gameProcess, ["port"] = _port, ["mapExe"] = Path.Combine(_gameDir, "SOTFLiveMap", "SOTF Live Map.exe"),
                ["mapArgs"] = args, ["result"] = Path.Combine(_updates, "result.json"),
            }.ToJsonString());

            // Its own process with its own (hidden) console: it outlives this map, which the installer closes.
            var psi = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = _updates };
            foreach (var a in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", runner, "-Job", job })
                psi.ArgumentList.Add(a);
            using (var runnerProcess = Process.Start(psi))
                lock (_lock)
                {
                    _runnerPid = runnerProcess?.Id ?? 0;
                    _phase = "waiting";
                    _message = null;
                }
            Console.WriteLine($"  Update {to} downloaded and checked. It installs when the game is closed.");
        }
        catch (Exception e)
        {
            lock (_lock)
            {
                _phase = "failed";
                _message = e switch
                {
                    UpdateFailed => e.Message,
                    HttpRequestException { StatusCode: { } code } => $"The download of {to} failed (GitHub answered {(int)code}). Nothing was installed. Try again later, or download it from the release page.",
                    HttpRequestException => $"The download of {to} failed ({Short(e.Message)}). Nothing was installed.",
                    OperationCanceledException => $"The download of {to} took too long and was stopped. Nothing was installed.",
                    _ => $"The update to {to} failed: {Short(e.Message)}",
                };
            }
        }
        Publish();
    }

    private void Download(string url, string path, string to)
    {
        using var res = Http.Send(new HttpRequestMessage(HttpMethod.Get, url) { Headers = { { "User-Agent", $"SOTF-Live-Map/{Current.ToString(3)}" } } },
            HttpCompletionOption.ResponseHeadersRead);
        res.EnsureSuccessStatusCode();
        var total = res.Content.Headers.ContentLength;
        if (total > MaxZip)
            throw new UpdateFailed("The release zip is far bigger than expected, so it wasn't downloaded.");
        using var input = res.Content.ReadAsStream();
        using var output = File.Create(path);
        var buffer = new byte[81920];
        long done = 0;
        var shown = Stopwatch.StartNew();
        int n;
        while ((n = input.Read(buffer, 0, buffer.Length)) > 0)
        {
            output.Write(buffer, 0, n);
            done += n;
            if (done > MaxZip)
                throw new UpdateFailed("The release zip is far bigger than expected, so it wasn't downloaded.");
            if (shown.ElapsedMilliseconds > 500)
            {
                shown.Restart();
                SetMessage(total is > 0 ? $"Downloading {to} ({done >> 20} of {total.Value >> 20} MB)…" : $"Downloading {to} ({done >> 20} MB)…");
            }
        }
    }

    private string ShaFile(string url)
    {
        if (url == null)
            return null;
        try
        {
            using var res = Http.Send(new HttpRequestMessage(HttpMethod.Get, url) { Headers = { { "User-Agent", $"SOTF-Live-Map/{Current.ToString(3)}" } } });
            res.EnsureSuccessStatusCode();
            using var reader = new StreamReader(res.Content.ReadAsStream());
            var m = Regex.Match(reader.ReadToEnd(), @"\b([0-9a-fA-F]{64})\b");
            return m.Success ? m.Groups[1].Value : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>"SHA-256 (SOTF-Live-Map-x.zip): &lt;hex&gt;" in the release notes (build\publish.ps1 writes it).</summary>
    private static string ShaInNotes(string notes, string zipName)
    {
        var m = Regex.Match(notes ?? "", @"SHA-?256[^\n]*?" + Regex.Escape(zipName ?? "") + @"[^\n]*?\b([0-9a-fA-F]{64})\b", RegexOptions.IgnoreCase);
        return m.Success ? m.Groups[1].Value : null;
    }

    private void SetMessage(string message)
    {
        lock (_lock)
            _message = message;
        Publish();
    }

    /// <summary>
    /// At start: the result of an update that just ran (shown once on the page), an update still waiting for the
    /// game to close, and the download folders of versions that are now installed (removed).
    /// </summary>
    private void Recover()
    {
        try
        {
            ReadResult();
            if (!Directory.Exists(_updates))
                return;
            foreach (var dir in Directory.GetDirectories(_updates))
            {
                if (!Version.TryParse(Path.GetFileName(dir), out var v))
                    continue;
                if (PendingRunner(dir) is var pid and > 0)
                {
                    _phase = "waiting";
                    _pendingTo = Path.GetFileName(dir);
                    _runnerPid = pid;
                    continue;
                }
                if (Trim(v) <= Current)
                {
                    try { Directory.Delete(dir, true); }
                    catch (Exception) { /* in use; next start */ }
                }
            }
        }
        catch (Exception e)
        {
            Console.WriteLine($"  Could not read the update folder ({e.Message}).");
        }
    }

    /// <summary>The installer's result (written by run-update.ps1), once: the page shows it.</summary>
    private bool ReadResult()
    {
        var result = Path.Combine(_updates, "result.json");
        if (!File.Exists(result))
            return false;
        try
        {
            _updated = JsonNode.Parse(File.ReadAllText(result)) as JsonObject;
            File.Delete(result);
        }
        catch (Exception)
        {
            return false; // still being written; next time
        }
        if (_updated != null)
            Console.WriteLine(_updated["ok"]?.GetValue<bool>() == true
                ? $"  Updated from {_updated["from"]} to {_updated["to"]}."
                : $"  The update to {_updated["to"]} didn't finish. Log: {_updated["log"]}");
        return true;
    }

    /// <summary>While waiting: the installer is done (it normally closes this map first, so this is when it failed early).</summary>
    private void PickUpResult()
    {
        if (ReadResult())
        {
            _phase = "idle";
            _message = null;
        }
        else if (!RunnerAlive(_runnerPid))
        {
            _phase = "failed";
            _message = $"The update to {_pendingTo} stopped before it finished. Its log: {Path.Combine(_updates, _pendingTo ?? "", "install.log")}";
        }
    }

    /// <summary>The process id of run-update.ps1 still waiting in this folder, else 0.</summary>
    private static int PendingRunner(string dir)
    {
        try
        {
            var pending = Path.Combine(dir, "pending.json");
            if (File.Exists(pending) && JsonNode.Parse(File.ReadAllText(pending))?["pid"] is JsonValue v && v.TryGetValue<int>(out var pid) && RunnerAlive(pid))
                return pid;
        }
        catch (Exception)
        {
            // unreadable: not waiting
        }
        return 0;
    }

    private static bool RunnerAlive(int pid)
    {
        if (pid <= 0)
            return false;
        try
        {
            using var p = Process.GetProcessById(pid);
            return !p.HasExited && p.ProcessName.Equals("powershell", StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>CheckForUpdates under [LiveMap] in the game's MelonPreferences.cfg (the mod adds it); null when not set.</summary>
    private bool? ReadPref()
    {
        if (_gameDir == null)
            return null;
        try
        {
            var cfg = Path.Combine(_gameDir, "UserData", "MelonPreferences.cfg");
            if (!File.Exists(cfg))
                return null;
            var section = "";
            foreach (var line in File.ReadLines(cfg))
            {
                var t = line.Trim();
                if (t.StartsWith('[') && t.EndsWith(']'))
                    section = t[1..^1].Trim();
                else if (section == "LiveMap" && Regex.Match(t, @"^CheckForUpdates\s*=\s*(\w+)") is { Success: true } m)
                    return !m.Groups[1].Value.Equals("false", StringComparison.OrdinalIgnoreCase);
            }
        }
        catch (Exception)
        {
            // unreadable: as if not set
        }
        return null;
    }

    private static Version Trim(Version v) => v == null ? new Version(0, 0, 0) : new Version(v.Major, v.Minor, Math.Max(v.Build, 0));
    private static string Clip(string s, int n) => s.Length > n ? s[..n] : s;
    private static string Short(string s) => Clip((s ?? "").Split('\n')[0].Trim(), 200);

    private sealed class UpdateFailed : Exception
    {
        public UpdateFailed(string message) : base(message) { }
    }

    /// <summary>Runs outside the map (the installer closes the map), with job.json next to it.</summary>
    private const string RunnerScript = """
# Written by SOTF Live Map when you pressed Update. Waits until the game is closed, runs the new release's own
# installer (install.ps1 -Yes keeps your progress and settings), then starts the map again if it was open.
param([string]$Job)
$ErrorActionPreference = 'Stop'
$j = Get-Content -LiteralPath $Job -Raw | ConvertFrom-Json
$dir = Split-Path -Parent $Job
$log = Join-Path $dir 'install.log'
$pending = Join-Path $dir 'pending.json'
function Log($text) { Add-Content -LiteralPath $log -Value "$(Get-Date -Format s)  $text" }
[IO.File]::WriteAllText($pending, (@{ pid = $PID; to = $j.to } | ConvertTo-Json -Compress))
Log "Update $($j.from) -> $($j.to). Waiting until $($j.gameProcess) is closed."
while (Get-Process -Name $j.gameProcess -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 3 }

$mapWasOpen = $false
try {
    $c = New-Object Net.Sockets.TcpClient
    $mapWasOpen = $c.ConnectAsync('127.0.0.1', [int]$j.port).Wait(1000) -and $c.Connected
    $c.Dispose()
} catch { }
Log "Running $($j.installer) -Yes -GameDir $($j.gameDir)"
$code = 1
try {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $j.installer -Yes -GameDir $j.gameDir 2>&1
    $code = $LASTEXITCODE
    foreach ($line in $out) { Log "  | $line" }
} catch { Log "Could not run the installer: $_" }
Log "Installer exit code: $code"
$result = @{ from = $j.from; to = $j.to; ok = ($code -eq 0); code = $code; log = $log; t = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
[IO.File]::WriteAllText($j.result, ($result | ConvertTo-Json -Compress))
Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue

if ($mapWasOpen -and (Test-Path -LiteralPath $j.mapExe)) {
    $argLine = (@($j.mapArgs) | Where-Object { $_ } | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
    if ($argLine) { Start-Process -FilePath $j.mapExe -ArgumentList $argLine -WorkingDirectory (Split-Path $j.mapExe) }
    else { Start-Process -FilePath $j.mapExe -WorkingDirectory (Split-Path $j.mapExe) }
    Log 'Started the map again.'
}
""";
}
