using System.Collections.Concurrent;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace LiveMap;

/// <summary>
/// The map's local web server. Serves web/ to this PC and to phones on the same Wi-Fi, keeps your
/// progress (found markers, pins, trail) in progress.json, relays the live feed from the game mod,
/// and shows your latest save (position, camps, parked vehicles) when the game isn't feeding it.
/// </summary>
public sealed class MapServer
{
    private const double TrailMinStep = 12; // metres between recorded live trail points
    private const double TrailMinClimb = 8;  // or this much up or down
    private const double LiveFreshSeconds = 15;

    private readonly string _web;
    private readonly string _progressPath;
    private readonly int _port;
    private readonly bool _localOnly;
    private readonly object _lock = new();
    private readonly List<BlockingCollection<byte[]>> _clients = new();
    private readonly SaveWatcher _saves;
    private JsonObject _state = NewState();
    private JsonObject _position; // last known position, live or from a save
    private List<SaveInfo> _saveList = new(); // every save, oldest first (by the game's save time)
    private string _active;                   // the world being played (live), else the newest save's world
    private readonly string _importFile;      // progress from an earlier version, put next to the app by the installer
    private bool _saveBlocked;                // progress.json exists but can't be read: never overwrite it
    private TcpListener _listener;
    private double _lastSave;

    public MapServer(string webRoot, string dataDir, string savesDir, int port, bool localOnly, string importFile = null)
    {
        _web = Path.GetFullPath(webRoot);
        _progressPath = Path.Combine(dataDir, "progress.json");
        _importFile = importFile;
        _port = port;
        _localOnly = localOnly;
        _saves = new SaveWatcher(savesDir, Path.Combine(_web, "data", "structures.json"), this);
        SavesDir = savesDir;
    }

    public string SavesDir { get; }
    /// <summary>The update check (GET/POST /api/update); null when this copy doesn't check.</summary>
    public Updater Updater { get; set; }
    public string LocalUrl => $"http://localhost:{_port}/";
    public string PhoneUrl => _localOnly ? null : LanIp() is { } ip ? $"http://{ip}:{_port}/" : null;

    /// <summary>Takes the port. False when it's taken (normally: the map is already running).</summary>
    public bool CanListen()
    {
        try
        {
            _listener = new TcpListener(_localOnly ? IPAddress.Loopback : IPAddress.Any, _port);
            _listener.Start();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    /// <summary>Loads your progress, reads the saves and starts answering (after <see cref="CanListen"/>).</summary>
    public void Start()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_progressPath)!);
        LoadProgress();
        ImportEarlierProgress();
        _saves.Scan(initial: true);
        _saves.Start();
        new Thread(AcceptLoop) { IsBackground = true, Name = "LiveMap.Accept" }.Start();
    }

    public void Stop()
    {
        lock (_lock)
            SaveProgress();
    }

    // ---------- progress file ----------

    // progress.json: { "worlds": { "<world uid>": { "found": [...], "pins": [...] } }, "trail": [...], "seenSaves": [...] }
    // Found markers and pins belong to one world; the trail is shared and every point says its world ("w").
    // "legacy": { "found", "pins" } is progress from before worlds existed, kept until we know which world it is
    // (the newest save's, or the one you play). "imported": the earlier-version files already looked at.
    private static JsonObject NewState() => new()
    {
        ["worlds"] = new JsonObject(), ["trail"] = new JsonArray(), ["seenSaves"] = new JsonArray(),
    };

    private void LoadProgress()
    {
        if (!File.Exists(_progressPath))
            return;
        JsonObject data;
        try
        {
            data = JsonNode.Parse(ReadShared(_progressPath)) as JsonObject ?? throw new JsonException("not a JSON object");
        }
        catch (IOException e) // locked by another program even after waiting: keep it as it is
        {
            Console.WriteLine($"  Could not open progress.json ({e.Message}). Your progress there is left untouched, and changes made now are not saved.");
            _saveBlocked = true;
            return;
        }
        catch (Exception e)
        {
            Console.WriteLine($"  Could not read progress.json ({e.Message}); starting fresh. The old file is kept as progress.bad.json");
            File.Move(_progressPath, Path.ChangeExtension(_progressPath, ".bad.json"), true);
            return;
        }
        _state = ToState(data);
    }

    /// <summary>Any progress file (this version's or an earlier one) as this version's state.</summary>
    internal static JsonObject ToState(JsonObject data)
    {
        var state = NewState();
        foreach (var key in new[] { "trail", "seenSaves", "imported" })
            if (data[key] is JsonArray arr)
                state[key] = arr.Clone();
        if (data["worlds"] is JsonObject worlds)
            state["worlds"] = worlds.Clone();
        if (data["legacy"] is JsonObject legacy)
            state["legacy"] = legacy.Clone();
        else if (data["worlds"] == null && (data["found"] is JsonArray || data["pins"] is JsonArray)) // before worlds: one shared set
            state["legacy"] = new JsonObject
            {
                ["found"] = (data["found"] as JsonArray)?.Clone() ?? new JsonArray(),
                ["pins"] = (data["pins"] as JsonArray)?.Clone() ?? new JsonArray(),
            };
        return state;
    }

    /// <summary>Reads a file another program may have open, waiting a moment if it's locked (an installer copying it, a virus scan).</summary>
    private static string ReadShared(string path)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var reader = new StreamReader(fs);
                return reader.ReadToEnd();
            }
            catch (IOException) when (attempt < 20 && File.Exists(path))
            {
                Thread.Sleep(250);
            }
        }
    }

    /// <summary>Whether a progress file (any version) has found markers or pins in any world.</summary>
    internal static bool FileHasProgress(string path)
    {
        try { return JsonNode.Parse(ReadShared(path)) is JsonObject o && HasProgress(ToState(o)); }
        catch (Exception) { return false; }
    }

    private static bool HasProgress(JsonObject state) =>
        new[] { state["legacy"] }.Concat(((JsonObject)state["worlds"]).Select(w => w.Value))
            .Any(p => p?["found"] is JsonArray { Count: > 0 } || p?["pins"] is JsonArray { Count: > 0 });

    /// <summary>
    /// The installer puts the progress of an earlier version (the old Python map's progress.json) next to the
    /// app, because an installer started from a packaged app (Windows Store, MSIX) can't reliably write to
    /// %LOCALAPPDATA%: Windows redirects the new file into that app's private folder, where the map never
    /// sees it. It's used when your progress here has no found markers or pins in any world, and each file is
    /// only looked at once (so clearing your map later doesn't bring it back).
    /// </summary>
    private void ImportEarlierProgress()
    {
        if (_importFile == null || _saveBlocked || !File.Exists(_importFile))
            return;
        string text;
        try { text = ReadShared(_importFile); }
        catch (IOException) { return; } // try again next start
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..16];
        var imported = _state["imported"] as JsonArray ?? new JsonArray();
        if (imported.Any(n => n?.ToString() == hash))
            return;

        JsonObject old = null;
        try { old = JsonNode.Parse(text) is JsonObject o ? ToState(o) : null; }
        catch (Exception) { /* unreadable: nothing to import */ }

        if (old != null && HasProgress(old) && !HasProgress(_state))
        {
            if (File.Exists(_progressPath))
                File.Copy(_progressPath, Path.Combine(Path.GetDirectoryName(_progressPath)!, "progress.before-import.json"), true);
            // keep what this version already saw (trail points, saves), take the found markers and pins from the old file
            var trail = old["trail"]!.AsArray().Concat(Arr("trail")).Select(n => n!.Clone())
                .GroupBy(n => $"{n["t"]}|{n["x"]}|{n["y"]}").Select(g => g.First())
                .OrderBy(n => n["t"]?.GetValue<double>() ?? 0).ToArray();
            var seen = old["seenSaves"]!.AsArray().Concat(Arr("seenSaves")).Select(n => n?.ToString()).Distinct().Select(s => (JsonNode)s).ToArray();
            old["trail"] = new JsonArray(trail);
            old["seenSaves"] = new JsonArray(seen);
            _state = old;
            Console.WriteLine($"  Imported your progress from the earlier version ({_importFile}).");
        }
        imported = _state["imported"] as JsonArray ?? new JsonArray();
        imported.Add(hash);
        _state["imported"] = imported;
        SaveProgress();
    }

    /// <summary>Progress from before worlds existed goes to the given world (the newest save's, or the one being played).</summary>
    private bool MigrateLegacy(string world)
    {
        if (_state["legacy"] is not JsonObject legacy || string.IsNullOrEmpty(world))
            return false;
        var p = Progress(world);
        var found = new SortedSet<long>(((JsonArray)p["found"]).Concat(legacy["found"] as JsonArray ?? new JsonArray())
            .Where(n => n is JsonValue v && v.TryGetValue<long>(out _)).Select(n => n.GetValue<long>()));
        p["found"] = new JsonArray(found.Select(i => (JsonNode)i).ToArray());
        var pins = ((JsonArray)p["pins"]).Select(n => n.Clone()).ToList();
        foreach (var pin in (legacy["pins"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
            if (pins.All(q => q?["id"]?.ToString() != pin["id"]?.ToString()))
                pins.Add(pin.Clone());
        p["pins"] = new JsonArray(pins.ToArray());
        foreach (var point in Arr("trail").OfType<JsonObject>())
            if (point["w"] == null)
                point["w"] = world;
        _state.Remove("legacy");
        Console.WriteLine($"  Your found markers and pins now belong to world {world}.");
        return true;
    }

    private void SaveProgress()
    {
        if (_saveBlocked)
            return;
        var tmp = _progressPath + ".tmp";
        File.WriteAllText(tmp, _state.ToJsonString());
        File.Move(tmp, _progressPath, true);
        _lastSave = Now();
    }

    private JsonArray Arr(string key) => (JsonArray)_state[key];

    /// <summary>The found markers and pins of one world (created on first use).</summary>
    private JsonObject Progress(string world)
    {
        var worlds = (JsonObject)_state["worlds"];
        world ??= "default";
        if (worlds[world] is not JsonObject w)
            worlds[world] = w = new JsonObject { ["found"] = new JsonArray(), ["pins"] = new JsonArray() };
        return w;
    }

    /// <summary>Sends an event to every open map page (for parts outside this class, like the update check).</summary>
    public void Publish(string ev, JsonNode payload)
    {
        lock (_lock)
            Broadcast(ev, payload);
    }

    private void Broadcast(string ev, JsonNode payload)
    {
        var msg = Encoding.UTF8.GetBytes($"event: {ev}\ndata: {payload?.ToJsonString() ?? "null"}\n\n");
        foreach (var q in _clients.ToArray())
            q.TryAdd(msg);
    }

    private bool LiveRecent() =>
        _position?["source"]?.GetValue<string>() == "live" && Now() - _position["time"].GetValue<double>() < LiveFreshSeconds;

    /// <summary>Which world the map shows: the one being played, else the one you saved last.</summary>
    private string ResolveActive()
    {
        if (LiveRecent() && _position["world"]?.ToString() is { Length: > 0 } live)
            return live;
        return _saveList.LastOrDefault(s => s.World != null)?.World ?? _active ?? "default";
    }

    /// <summary>Every world you have (from saves, plus a world being played that was never saved), newest first.</summary>
    private JsonArray Catalog()
    {
        var list = new List<JsonObject>();
        foreach (var g in _saveList.Where(s => s.World != null).GroupBy(s => s.World))
        {
            var saves = g.OrderBy(s => s.Time).ToList();
            var newest = saves[^1];
            var withData = saves.LastOrDefault(s => s.HasWorldData);
            var progress = Progress(g.Key);
            list.Add(new JsonObject
            {
                ["uid"] = g.Key, ["difficulty"] = newest.Difficulty,
                ["modes"] = new JsonArray(saves.Select(s => s.Mode).Distinct().Select(m => (JsonNode)m).ToArray()),
                ["started"] = saves[0].Time, ["last"] = newest.Time, ["day"] = newest.Day, ["saves"] = saves.Count,
                ["label"] = newest.Label, ["mode"] = newest.Mode,
                ["camps"] = withData?.Camps.Clone() ?? new JsonArray(), ["vehicles"] = withData?.Vehicles.Clone() ?? new JsonArray(),
                ["history"] = withData?.History.Clone() ?? new JsonObject(),
                ["found"] = progress["found"].Clone(), ["pins"] = progress["pins"].Clone(), ["target"] = progress["target"]?.Clone(),
                ["encountered"] = List(progress, "encountered"), ["revealed"] = List(progress, "revealed"),
                ["seen"] = List(progress, "seen"), ["probable"] = List(progress, "probable"), ["dismissed"] = List(progress, "dismissed"),
            });
        }
        // a world you're playing that has no save yet (or one that only has progress)
        foreach (var (uid, progress) in (JsonObject)_state["worlds"])
        {
            if (list.Any(w => w["uid"]!.ToString() == uid))
                continue;
            var live = LiveRecent() && _position["world"]?.ToString() == uid;
            if (!live && uid != _active)
                continue;
            list.Add(new JsonObject
            {
                ["uid"] = uid, ["difficulty"] = live ? _position["difficulty"]?.ToString() : null,
                ["modes"] = new JsonArray(), ["started"] = Now(), ["last"] = Now(), ["day"] = null, ["saves"] = 0, ["new"] = true,
                ["camps"] = new JsonArray(), ["vehicles"] = new JsonArray(),
                ["found"] = progress["found"].Clone(), ["pins"] = progress["pins"].Clone(), ["target"] = progress["target"]?.Clone(),
                ["encountered"] = List(progress, "encountered"), ["revealed"] = List(progress, "revealed"),
                ["seen"] = List(progress, "seen"), ["probable"] = List(progress, "probable"), ["dismissed"] = List(progress, "dismissed"),
            });
        }
        return new JsonArray(list.OrderByDescending(w => w["last"]!.GetValue<double>()).Select(w => (JsonNode)w).ToArray());
    }

    private static JsonArray List(JsonNode progress, string key) => progress?[key] is JsonArray a ? a.Clone() : new JsonArray();

    private JsonObject WorldsMessage() => new() { ["active"] = _active, ["worlds"] = Catalog() };

    private void UpdateActive(bool force = false)
    {
        var active = ResolveActive();
        if (!force && active == _active)
            return;
        _active = active;
        Progress(active); // a brand-new world gets its own empty progress straight away
        Broadcast("worlds", WorldsMessage());
    }

    // ---------- called by the save watcher ----------

    /// <summary>Every few seconds: when the live feed stops, go back to the world you saved last.</summary>
    internal void Tick()
    {
        lock (_lock)
            UpdateActive();
    }

    internal void OnSaves(List<SaveInfo> saves)
    {
        lock (_lock)
        {
            _saveList = saves;
            var newest = saves.LastOrDefault();
            // progress from before worlds: it's all from the world you saved last
            var changed = MigrateLegacy(saves.LastOrDefault(s => s.World != null)?.World);

            var seen = new HashSet<string>(Arr("seenSaves").Select(n => n?.ToString()));
            foreach (var info in saves.Where(s => !seen.Contains(s.Key)))
            {
                Arr("seenSaves").Add(info.Key);
                Arr("trail").Add(new JsonObject
                {
                    ["x"] = info.X, ["y"] = info.Z, ["h"] = Math.Round(info.H, 1), ["t"] = info.Time, ["s"] = "save", ["w"] = info.World, ["l"] = info.Label,
                });
                changed = true;
            }
            if (changed)
            {
                var sorted = Arr("trail").Select(n => n.Clone()).OrderBy(n => n["t"]?.GetValue<double>() ?? 0).ToList();
                _state["trail"] = new JsonArray(sorted.ToArray());
                SaveProgress();
                Broadcast("trail", Arr("trail"));
            }
            if (newest != null && !LiveRecent() && _position?["time"]?.GetValue<double>() != newest.Time)
            {
                _position = newest.ToPosition();
                Broadcast("position", _position);
            }
            UpdateActive(force: true); // camps, vehicles or the save list changed
        }
    }

    /// <summary>The world of a save slot the game says is loaded (when the mod can't read the world id itself).</summary>
    private string WorldOfSlot(string mode, string slot) =>
        _saveList.LastOrDefault(s => s.Slot == slot && (mode == null || s.Mode == mode || mode == "MultiplayerClient"))?.World;

    // ---------- HTTP ----------

    private void AcceptLoop()
    {
        while (true)
        {
            TcpClient client;
            try { client = _listener.AcceptTcpClient(); }
            catch (Exception) { return; }
            new Thread(() => Handle(client)) { IsBackground = true, Name = "LiveMap.Request" }.Start();
        }
    }

    private void Handle(TcpClient client)
    {
        using (client)
        {
            try
            {
                client.NoDelay = true;
                var stream = client.GetStream();
                stream.ReadTimeout = 15000; // an idle kept-alive connection closes after this
                var reader = new HttpReader(stream);
                // Browsers reuse a connection for the next file (a phone loads dozens of tiles at once);
                // the API and the event stream close theirs.
                for (var served = 0; served < 500; served++)
                {
                    var req = reader.Read();
                    if (req == null || !Serve(stream, req))
                        return;
                }
            }
            catch (Exception)
            {
                // client went away mid-request, or an idle connection timed out; nothing to do
            }
        }
    }

    /// <summary>Answers one request. True when the connection can stay open for the next one.</summary>
    private bool Serve(NetworkStream stream, HttpRequest req)
    {
        var path = req.Path;
        if (req.Method == "GET" && path == "/api/events")
        {
            EventStream(stream);
            return false;
        }
        if (req.Method == "GET" && path == "/api/state")
        {
            JsonObject body;
            lock (_lock)
            {
                body = WorldsMessage();
                body["trail"] = Arr("trail").Clone();
                body["position"] = _position?.Clone();
                body["info"] = new JsonObject { ["phoneUrl"] = PhoneUrl, ["savesFound"] = Directory.Exists(SavesDir), ["version"] = Updater.Current.ToString(3) };
            }
            Json(stream, 200, body, req.KeepAlive);
            return req.KeepAlive;
        }
        if (req.Method == "GET" && path == "/api/update")
        {
            Json(stream, 200, Updater?.Status() ?? new JsonObject { ["version"] = Updater.Current.ToString(3), ["on"] = false }, req.KeepAlive);
            return req.KeepAlive;
        }
        if (req.Method == "POST")
        {
            JsonNode data;
            try { data = req.Body.Length == 0 ? new JsonObject() : JsonNode.Parse(req.Body); }
            catch (JsonException) { Json(stream, 400, Error("send JSON"), req.KeepAlive); return req.KeepAlive; }
            var (status, reply) = path switch
            {
                "/api/found" => UpdateFound(data),
                "/api/pins" => UpdatePins(data),
                "/api/marks" => UpdateMarks(data),
                "/api/trail/clear" => ClearTrail(data),
                "/api/trail/restore" => RestoreTrail(data),
                "/api/position" => LivePosition(data),
                "/api/target" => SetTarget(data),
                "/api/update" => Updater?.Handle(data) ?? (400, Error("this copy of the map doesn't check for updates")),
                _ => (404, Error("unknown endpoint")),
            };
            Json(stream, status, reply, req.KeepAlive);
            return req.KeepAlive;
        }
        if (req.Method == "GET" || req.Method == "HEAD")
        {
            StaticFile(stream, req);
            return req.KeepAlive;
        }
        Respond(stream, 405, "text/plain", Encoding.UTF8.GetBytes("method not allowed"));
        return false;
    }

    private static JsonObject Error(string msg) => new() { ["error"] = msg };

    private (int, JsonNode) UpdateFound(JsonNode data)
    {
        // Location ids go beyond 32 bits (41 of them, like 1713858317296), so they're longs throughout.
        if (data?["ids"] is not JsonArray ids || ids.Any(i => i is not JsonValue v || !v.TryGetValue<long>(out _)))
            return (400, Error("ids must be a list of numbers"));
        var add = data["found"]?.GetValue<bool>() == true;
        lock (_lock)
        {
            var world = WorldParam(data);
            var progress = Progress(world);
            var found = new SortedSet<long>(((JsonArray)progress["found"]).OfType<JsonValue>()
                .Where(v => v.TryGetValue<long>(out _)).Select(v => v.GetValue<long>()));
            foreach (var i in ids.Select(n => n.GetValue<long>()))
                if (add) found.Add(i); else found.Remove(i);
            progress["found"] = new JsonArray(found.Select(i => (JsonNode)i).ToArray());
            SaveProgress();
            Broadcast("found", new JsonObject { ["world"] = world, ["found"] = progress["found"].Clone() });
            return (200, new JsonObject { ["world"] = world, ["found"] = progress["found"].Clone() });
        }
    }

    /// <summary>
    /// The lists Explore mode keeps per world, next to found and pins: "encountered" (locked spots you've been
    /// near, so they show as locks), "revealed" (locations you chose to see, or your in-game GPS shows),
    /// "seen" (vehicles you came near), "probable" (where an item you carry most likely came from) and
    /// "dismissed" (such guesses you said no to).
    /// {world, kind, ids, on (default true)}.
    /// </summary>
    private (int, JsonNode) UpdateMarks(JsonNode data)
    {
        var kind = data?["kind"]?.ToString();
        if (kind is not ("encountered" or "revealed" or "seen" or "probable" or "dismissed"))
            return (400, Error("kind must be encountered, revealed, seen, probable or dismissed"));
        if (data["ids"] is not JsonArray ids || ids.Any(i => i is not JsonValue v || !v.TryGetValue<long>(out _)))
            return (400, Error("ids must be a list of numbers"));
        var on = data["on"] is not JsonValue ov || !ov.TryGetValue<bool>(out var b) || b;
        lock (_lock)
        {
            var world = WorldParam(data);
            var progress = Progress(world);
            var set = new SortedSet<long>((progress[kind] as JsonArray ?? new JsonArray()).OfType<JsonValue>()
                .Where(v => v.TryGetValue<long>(out _)).Select(v => v.GetValue<long>()));
            var changed = false;
            foreach (var i in ids.Select(n => n.GetValue<long>()))
                changed |= on ? set.Add(i) : set.Remove(i);
            progress[kind] = new JsonArray(set.Select(i => (JsonNode)i).ToArray());
            if (changed)
                SaveProgress();
            var reply = new JsonObject { ["world"] = world, ["kind"] = kind, ["ids"] = progress[kind].Clone() };
            if (changed)
                Broadcast("marks", reply.Clone());
            return (200, reply);
        }
    }

    /// <summary>The world a change is for: the one the page is showing, else the active world.</summary>
    private string WorldParam(JsonNode data) => data?["world"]?.ToString() is { Length: > 0 } w ? w : _active ?? ResolveActive();

    private (int, JsonNode) UpdatePins(JsonNode data)
    {
        var action = data?["action"]?.ToString();
        var pin = data?["pin"] as JsonObject ?? new JsonObject();
        var id = pin["id"]?.ToString();
        lock (_lock)
        {
            var world = WorldParam(data);
            var progress = Progress(world);
            var pins = ((JsonArray)progress["pins"]).Where(p => p?["id"]?.ToString() != id).Select(p => p.Clone()).ToList();
            if (action == "save")
            {
                if (id == null || !TryNum(pin["x"], out var x) || !TryNum(pin["y"], out var y))
                    return (400, Error("pin needs id, x and y"));
                pins.Add(new JsonObject
                {
                    ["id"] = Clip(id, 40), ["x"] = x, ["y"] = y,
                    ["label"] = Clip(pin["label"]?.ToString() ?? "", 80), ["kind"] = Clip(pin["kind"]?.ToString() ?? "note", 20), ["t"] = Now(),
                });
            }
            else if (action != "delete")
            {
                return (400, Error("action must be save or delete"));
            }
            progress["pins"] = new JsonArray(pins.ToArray());
            SaveProgress();
            Broadcast("pins", new JsonObject { ["world"] = world, ["pins"] = progress["pins"].Clone() });
            return (200, new JsonObject { ["world"] = world, ["pins"] = progress["pins"].Clone() });
        }
    }

    /// <summary>
    /// "Guide me here": {target: {x, y, label, kind, id}} sets where the in-game arrow points (y = the map's
    /// north-south coordinate, i.e. the game's z); {target: null} stops guiding. One target per world.
    /// </summary>
    private (int, JsonNode) SetTarget(JsonNode data)
    {
        lock (_lock)
        {
            var world = WorldParam(data);
            var progress = Progress(world);
            JsonObject target = null;
            if (data?["target"] is JsonObject t)
            {
                if (!TryNum(t["x"], out var x) || !TryNum(t["y"], out var y))
                    return (400, Error("target needs x and y"));
                target = new JsonObject
                {
                    ["x"] = Math.Round(x, 2), ["y"] = Math.Round(y, 2),
                    ["label"] = Clip(t["label"]?.ToString() ?? "Target", 60), ["kind"] = Clip(t["kind"]?.ToString() ?? "loc", 12),
                    ["id"] = t["id"]?.ToString() is { } id ? Clip(id, 40) : null, ["t"] = Now(),
                };
                if (TryNum(t["h"], out var h))
                    target["h"] = Math.Round(h, 1);
            }
            progress["target"] = target;
            SaveProgress();
            Broadcast("target", new JsonObject { ["world"] = world, ["target"] = target?.Clone() });
            return (200, new JsonObject { ["world"] = world, ["target"] = target?.Clone() });
        }
    }

    private readonly Dictionary<string, JsonNode[]> _clearedTrail = new(); // per world, until Undo or the next reset

    /// <summary>
    /// {world}: removes that world's trail (and points without a world when it's the one being played);
    /// without a world, the whole trail. Saves already seen stay seen, so they don't come back.
    /// </summary>
    private (int, JsonNode) ClearTrail(JsonNode data)
    {
        var world = data?["world"]?.ToString() is { Length: > 0 } w ? w : null;
        lock (_lock)
        {
            var active = _active ?? ResolveActive();
            bool Mine(JsonNode p) => world == null || (p?["w"]?.ToString() is { } pw ? pw == world : world == active);
            var trail = Arr("trail");
            var removed = trail.Where(Mine).Select(p => p!.Clone()).ToArray();
            _clearedTrail[world ?? ""] = removed;
            _state["trail"] = new JsonArray(trail.Where(p => !Mine(p)).Select(p => p!.Clone()).ToArray());
            SaveProgress();
            Broadcast("trail", Arr("trail"));
            return (200, new JsonObject { ["ok"] = true, ["world"] = world, ["removed"] = removed.Length });
        }
    }

    /// <summary>Undo for the last reset of that world's trail.</summary>
    private (int, JsonNode) RestoreTrail(JsonNode data)
    {
        var key = data?["world"]?.ToString() is { Length: > 0 } w ? w : "";
        lock (_lock)
        {
            if (!_clearedTrail.Remove(key, out var points))
                return (200, new JsonObject { ["ok"] = true, ["restored"] = 0 });
            var merged = Arr("trail").Select(p => p!.Clone()).Concat(points.Select(p => p.Clone()))
                .OrderBy(p => p["t"]?.GetValue<double>() ?? 0).ToArray();
            _state["trail"] = new JsonArray(merged);
            SaveProgress();
            Broadcast("trail", Arr("trail"));
            return (200, new JsonObject { ["ok"] = true, ["restored"] = points.Length });
        }
    }

    /// <summary>
    /// Live feed from the game mod: {x, y, z} game coordinates (y = height), heading in degrees,
    /// cave (bool), area (the game's area mask), world (the loaded world's id), save {mode, id} (the
    /// loaded slot), difficulty, others (companions and other players) and tags (GPS markers).
    /// </summary>
    private (int, JsonNode) LivePosition(JsonNode data)
    {
        if (!TryNum(data?["x"], out var x) || !TryNum(data?["z"], out var z))
            return (400, Error("send game coordinates x, y, z"));
        TryNum(data["y"], out var h);
        var cave = data["cave"] is JsonValue cv && cv.TryGetValue<bool>(out var c) && c;
        lock (_lock)
        {
            // The world being played: the mod sends its id; older feeds only a save slot, or nothing.
            var mode = data["save"]?["mode"]?.ToString();
            var world = data["world"]?.ToString() is { Length: > 0 } uid ? uid
                : data["save"]?["id"] is { } slot ? WorldOfSlot(mode, slot.ToString()) : null;
            var migrated = MigrateLegacy(world); // no save told us the world yet, but the game does
            if (migrated)
                SaveProgress();
            world ??= _active ?? ResolveActive();
            var pos = new JsonObject
            {
                ["x"] = Math.Round(x, 2), ["y"] = Math.Round(z, 2), ["h"] = Math.Round(h, 1),
                ["heading"] = TryNum(data["heading"], out var hd) ? Math.Round(hd, 1) : null,
                ["cave"] = cave, ["time"] = Now(), ["source"] = "live", ["label"] = "Live",
                ["world"] = world, ["mode"] = mode, ["difficulty"] = data["difficulty"]?.ToString(),
            };
            if (TryNum(data["area"], out var area))
                pos["area"] = (int)area;
            if (data["others"] is JsonArray others)
                pos["others"] = Clean(others, 32, "k", "n", "c");
            if (data["tags"] is JsonArray tags)
                pos["tags"] = Clean(tags, 64, "t", "c");
            _position = pos;

            var trail = Arr("trail");
            JsonNode last = null; // this world's last step (the trail holds every world)
            for (var i = trail.Count - 1; i >= 0 && last == null; i--)
                if (trail[i]?["w"]?.ToString() is not { } tw || tw == pos["world"]?.ToString())
                    last = trail[i];
            // every 12 m, and also when you go underground or come back up, or change floor (the same spot on
            // the surface and in the bunker under it are different places)
            var levelChanged = last != null && (last["c"] != null != cave
                || (TryNum(last["h"], out var lastH) && Math.Abs(lastH - h) > TrailMinClimb));
            if (last == null || levelChanged
                || Math.Sqrt(Math.Pow(last["x"].GetValue<double>() - x, 2) + Math.Pow(last["y"].GetValue<double>() - z, 2)) >= TrailMinStep)
            {
                // the height and the game's area too, so a step over a bunker isn't taken for a step in it
                var point = new JsonObject
                {
                    ["x"] = pos["x"].GetValue<double>(), ["y"] = pos["y"].GetValue<double>(), ["h"] = pos["h"].GetValue<double>(),
                    ["t"] = Now(), ["s"] = "live", ["w"] = pos["world"]?.ToString(),
                };
                if (pos["area"] is JsonValue areaValue)
                    point["a"] = areaValue.GetValue<int>();
                if (cave)
                    point["c"] = 1;
                trail.Add(point);
                if (trail.Count % 20 == 0 || Now() - _lastSave > 30) // a hard stop then loses at most 30 s of trail
                    SaveProgress();
                Broadcast("trailAdd", point);
            }
            UpdateActive(force: migrated); // switches the map the moment you load another world, without saving
            Broadcast("position", _position);
            return (200, new JsonObject { ["ok"] = true, ["target"] = Progress(world)["target"]?.Clone() });
        }
    }

    /// <summary>Copies an array of small objects, keeping numbers, booleans and short strings only.</summary>
    private static JsonArray Clean(JsonArray items, int max, params string[] textKeys)
    {
        var outArr = new JsonArray();
        foreach (var item in items.OfType<JsonObject>().Take(max))
        {
            var o = new JsonObject();
            foreach (var (k, v) in item)
            {
                if (v is not JsonValue val)
                    continue;
                if (TryNum(val, out var n)) o[k] = Math.Round(n, 2);
                else if (val.TryGetValue<bool>(out var b)) o[k] = b;
                else if (textKeys.Contains(k) && val.TryGetValue<string>(out var s)) o[k] = Clip(s, 60);
            }
            if (TryNum(item["x"], out var ox) && TryNum(item["z"], out var oz))
            {
                o["x"] = Math.Round(ox, 2); o["y"] = Math.Round(oz, 2);
                if (TryNum(item["y"], out var oh)) o["h"] = Math.Round(oh, 1);
                o.Remove("z");
                outArr.Add(o);
            }
        }
        return outArr;
    }

    private void EventStream(NetworkStream stream)
    {
        var q = new BlockingCollection<byte[]>(new ConcurrentQueue<byte[]>(), 200);
        lock (_lock)
            _clients.Add(q);
        try
        {
            var head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\nretry: 3000\n\n";
            stream.Write(Encoding.ASCII.GetBytes(head));
            var keepAlive = Encoding.ASCII.GetBytes(": keep-alive\n\n");
            while (true)
            {
                var msg = q.TryTake(out var m, 15000) ? m : keepAlive;
                stream.Write(msg);
                stream.Flush();
            }
        }
        catch (Exception)
        {
            // browser closed the page
        }
        finally
        {
            lock (_lock)
                _clients.Remove(q);
        }
    }

    private static readonly Dictionary<string, string> Mime = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8", [".js"] = "text/javascript; charset=utf-8", [".css"] = "text/css; charset=utf-8",
        [".json"] = "application/json", [".webp"] = "image/webp", [".png"] = "image/png", [".jpg"] = "image/jpeg",
        [".svg"] = "image/svg+xml", [".ico"] = "image/x-icon", [".txt"] = "text/plain; charset=utf-8",
    };

    // The page's text files, kept gzipped in memory (they're read on every page load; about 620 KB, 150 KB zipped).
    private sealed record TextFile(DateTime Stamp, long Length, byte[] Bytes, byte[] Gzip);
    private readonly ConcurrentDictionary<string, TextFile> _textFiles = new(StringComparer.OrdinalIgnoreCase);
    private static readonly HashSet<string> Compressible = new(StringComparer.OrdinalIgnoreCase) { ".html", ".js", ".css", ".json", ".svg", ".txt" };

    private void StaticFile(NetworkStream stream, HttpRequest req)
    {
        var path = req.Path;
        var headOnly = req.Method == "HEAD";
        var rel = Uri.UnescapeDataString(path == "/" ? "/index.html" : path).TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
        var full = Path.GetFullPath(Path.Combine(_web, rel));
        var info = new FileInfo(full);
        if (!full.StartsWith(_web + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !info.Exists)
        {
            Respond(stream, 404, "text/plain", Encoding.UTF8.GetBytes("not found"), "no-store", null, req.KeepAlive);
            return;
        }
        var ext = Path.GetExtension(full);
        // The page itself is checked on every load (so an update shows straight away) but only sent again when it
        // changed; map tiles, icons and screenshots never change, so browsers keep them.
        var cache = ext is ".html" or ".js" or ".css" ? "no-cache"
            : rel.Split(Path.DirectorySeparatorChar)[0] is "tiles" or "icons" or "screenshots" ? "public, max-age=31536000, immutable"
            : "max-age=3600";
        var etag = $"\"{info.LastWriteTimeUtc.Ticks:x}-{info.Length:x}\"";
        var type = Mime.GetValueOrDefault(ext, "application/octet-stream");
        if (req.IfNoneMatch == etag)
        {
            Respond(stream, 304, type, Array.Empty<byte>(), cache, 0, req.KeepAlive, $"ETag: {etag}\r\n");
            return;
        }
        byte[] body;
        var extra = $"ETag: {etag}\r\n";
        if (Compressible.Contains(ext))
        {
            if (!_textFiles.TryGetValue(full, out var f) || f.Stamp != info.LastWriteTimeUtc || f.Length != info.Length)
            {
                var bytes = File.ReadAllBytes(full);
                using var ms = new MemoryStream();
                using (var gz = new GZipStream(ms, CompressionLevel.Optimal, true))
                    gz.Write(bytes);
                _textFiles[full] = f = new TextFile(info.LastWriteTimeUtc, info.Length, bytes, ms.ToArray());
            }
            extra += "Vary: Accept-Encoding\r\n";
            if (req.AcceptsGzip)
            {
                body = f.Gzip;
                extra += "Content-Encoding: gzip\r\n";
            }
            else
            {
                body = f.Bytes;
            }
        }
        else
        {
            body = File.ReadAllBytes(full);
        }
        Respond(stream, 200, type, headOnly ? Array.Empty<byte>() : body, cache, body.Length, req.KeepAlive, extra);
    }

    private static void Json(NetworkStream stream, int status, JsonNode body, bool keepAlive = false) =>
        Respond(stream, status, "application/json", Encoding.UTF8.GetBytes(body.ToJsonString()), "no-store", null, keepAlive);

    private static void Respond(NetworkStream stream, int status, string type, byte[] body, string cache = "max-age=3600", int? length = null,
        bool keepAlive = false, string extraHeaders = "")
    {
        var reason = status switch { 200 => "OK", 304 => "Not Modified", 400 => "Bad Request", 404 => "Not Found", 405 => "Method Not Allowed", _ => "Error" };
        var head = $"HTTP/1.1 {status} {reason}\r\nContent-Type: {type}\r\nContent-Length: {length ?? body.Length}\r\n" +
                   $"Cache-Control: {cache}\r\n" + extraHeaders +
                   (keepAlive ? "Connection: keep-alive\r\nKeep-Alive: timeout=15\r\n\r\n" : "Connection: close\r\n\r\n");
        stream.Write(Encoding.ASCII.GetBytes(head));
        stream.Write(body);
        stream.Flush();
    }

    // ---------- helpers ----------

    internal static double Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;

    private static string Clip(string s, int n) => s.Length > n ? s[..n] : s;

    internal static bool TryNum(JsonNode node, out double value)
    {
        value = 0;
        if (node is not JsonValue v)
            return false;
        if (v.TryGetValue<double>(out value)) return !double.IsNaN(value) && !double.IsInfinity(value);
        if (v.TryGetValue<int>(out var i)) { value = i; return true; }
        if (v.TryGetValue<long>(out var l)) { value = l; return true; }
        return false;
    }

    private static string LanIp()
    {
        try
        {
            using var s = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            s.Connect("10.255.255.255", 1); // nothing is sent; this only picks the outgoing network
            return ((IPEndPoint)s.LocalEndPoint)?.Address.ToString();
        }
        catch (SocketException)
        {
            return null;
        }
    }
}

internal sealed class HttpRequest
{
    public string Method;
    public string Path;
    public bool KeepAlive;
    public string IfNoneMatch;
    public bool AcceptsGzip;
    public byte[] Body = Array.Empty<byte>();
}

/// <summary>Just enough HTTP/1.1 request parsing for a local map server; reads one request after another from a connection.</summary>
internal sealed class HttpReader
{
    private readonly Stream _stream;
    private readonly byte[] _buf = new byte[65536];
    private int _len; // bytes in _buf that belong to the next request

    public HttpReader(Stream stream) => _stream = stream;

    public HttpRequest Read()
    {
        int headerEnd;
        while ((headerEnd = IndexOf(_buf, _len)) < 0)
        {
            if (_len == _buf.Length)
                return null;
            var n = _stream.Read(_buf, _len, _buf.Length - _len);
            if (n <= 0)
                return null;
            _len += n;
        }
        var lines = Encoding.ASCII.GetString(_buf, 0, headerEnd).Split("\r\n");
        var first = lines[0].Split(' ');
        if (first.Length < 2)
            return null;
        var req = new HttpRequest
        {
            Method = first[0].ToUpperInvariant(), Path = first[1].Split('?')[0],
            KeepAlive = first.Length > 2 && first[2] == "HTTP/1.1", // 1.1 keeps the connection unless it says otherwise
        };
        var contentLength = 0;
        foreach (var line in lines.Skip(1))
        {
            var i = line.IndexOf(':');
            if (i <= 0)
                continue;
            var name = line[..i].Trim();
            var value = line[(i + 1)..].Trim();
            if (name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
                int.TryParse(value, out contentLength);
            else if (name.Equals("If-None-Match", StringComparison.OrdinalIgnoreCase))
                req.IfNoneMatch = value;
            else if (name.Equals("Accept-Encoding", StringComparison.OrdinalIgnoreCase))
                req.AcceptsGzip = value.Contains("gzip", StringComparison.OrdinalIgnoreCase);
            else if (name.Equals("Connection", StringComparison.OrdinalIgnoreCase))
                req.KeepAlive = value.Contains("keep-alive", StringComparison.OrdinalIgnoreCase)
                    || (req.KeepAlive && !value.Contains("close", StringComparison.OrdinalIgnoreCase));
        }
        if (contentLength is < 0 or > 1_000_000)
            return null;
        var body = new byte[contentLength];
        var start = headerEnd + 4;
        var fromBuffer = Math.Min(_len - start, contentLength);
        Array.Copy(_buf, start, body, 0, fromBuffer);
        var have = fromBuffer;
        while (have < contentLength)
        {
            var n = _stream.Read(body, have, contentLength - have);
            if (n <= 0)
                return null;
            have += n;
        }
        // keep whatever came after this request for the next Read
        var used = start + fromBuffer;
        var rest = _len - used;
        Array.Copy(_buf, used, _buf, 0, rest);
        _len = rest;
        req.Body = body;
        return req;
    }

    private static int IndexOf(byte[] b, int len)
    {
        for (var i = 3; i < len; i++)
            if (b[i - 3] == '\r' && b[i - 2] == '\n' && b[i - 1] == '\r' && b[i] == '\n')
                return i - 3;
        return -1;
    }
}

internal static class JsonNodeExtensions
{
    /// <summary>Deep copy (System.Text.Json on .NET 6 has no DeepClone yet).</summary>
    public static T Clone<T>(this T node) where T : JsonNode => (T)JsonNode.Parse(node.ToJsonString());
}
