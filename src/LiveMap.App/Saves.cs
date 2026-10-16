using System.Buffers.Binary;
using System.Globalization;
using System.IO.Compression;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace LiveMap;

/// <summary>What the map needs from one save: where you were, plus (for the newest save) your camps and vehicles.</summary>
public sealed class SaveInfo
{
    public string Key, Path;
    public double X, Z, H;
    /// <summary>When the game says it saved (GameState.SaveTime); the file time only if that is missing.</summary>
    public double Time;
    public double? Heading;
    public string World, Label, Mode, Slot, Difficulty;
    public int? Day;
    public bool HasWorldData;
    public JsonArray Camps = new();
    public JsonArray Vehicles = new();
    /// <summary>What the save says about where you've been: see <see cref="SaveWatcher.ReadHistory"/>.</summary>
    public JsonObject History = new();
    /// <summary>Where the world isn't as it started: see <see cref="SaveWatcher.ReadChanged"/>.</summary>
    public List<(float x, float z, float h)> Changed = new();

    public JsonObject ToPosition() => new()
    {
        ["x"] = Math.Round(X, 2), ["y"] = Math.Round(Z, 2), ["h"] = Math.Round(H, 1),
        ["heading"] = Heading is { } hd ? Math.Round(hd, 1) : null,
        ["world"] = World, ["day"] = Day, ["label"] = Label, ["mode"] = Mode, ["time"] = Time, ["source"] = "save",
    };
}

/// <summary>Watches %USERPROFILE%\AppData\LocalLow\Endnight\SonsOfTheForest\Saves and reads new saves.</summary>
public sealed class SaveWatcher
{
    private const double CampRadius = 40; // structures closer than this belong to the same camp
    private const int CampMinPieces = 3;

    private readonly string _dir;
    private readonly MapServer _server;
    private readonly Dictionary<int, string> _structureNames = new();
    private readonly Dictionary<string, SaveInfo> _cache = new();
    private string _lastSignature;

    public SaveWatcher(string savesDir, string structureNamesFile, MapServer server)
    {
        _dir = savesDir;
        _server = server;
        try
        {
            if (File.Exists(structureNamesFile) && JsonNode.Parse(File.ReadAllText(structureNamesFile)) is JsonObject names)
                foreach (var (k, v) in names)
                    if (int.TryParse(k, out var id) && v != null)
                        _structureNames[id] = v.ToString();
        }
        catch (Exception)
        {
            // names are a nicety; camps still show without them
        }
    }

    public void Start() => new Thread(() =>
    {
        while (true)
        {
            Thread.Sleep(3000);
            try { Scan(initial: false); _server.Tick(); }
            catch (Exception e) { Console.WriteLine($"  Save watcher: {e.Message}"); }
        }
    }) { IsBackground = true, Name = "LiveMap.Saves" }.Start();

    public void Scan(bool initial)
    {
        if (!Directory.Exists(_dir))
            return;
        var files = Directory.GetFiles(_dir, "SaveData.zip", SearchOption.AllDirectories)
            .Where(p => Path.GetRelativePath(_dir, p).Split(Path.DirectorySeparatorChar).Length == 4); // <steamid>\<mode>\<slot>\SaveData.zip
        var infos = new List<SaveInfo>();
        var keys = new HashSet<string>();
        foreach (var path in files)
        {
            var key = KeyOf(path);
            keys.Add(key);
            if (!_cache.TryGetValue(key, out var info))
            {
                try
                {
                    info = Read(path, key);
                }
                catch (Exception e) // a save that is still being written, or an unexpected format
                {
                    if (!initial)
                        Console.WriteLine($"  Skipped save {path}: {e.Message}");
                    continue;
                }
                _cache[key] = info;
            }
            infos.Add(info);
        }
        foreach (var gone in _cache.Keys.Where(k => !keys.Contains(k)).ToList())
            _cache.Remove(gone);

        // Camps and vehicles come from the newest save of every world (by the game's own save time).
        foreach (var world in infos.GroupBy(i => i.World ?? ""))
        {
            var newest = world.OrderBy(i => i.Time).Last();
            if (newest.HasWorldData)
                continue;
            try
            {
                using var fs = new FileStream(newest.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var zip = new ZipArchive(fs, ZipArchiveMode.Read);
                newest.Camps = ReadCamps(zip);
                newest.Vehicles = ReadVehicles(zip);
                newest.History = ReadHistory(zip);
                newest.History["changed"] = ChangedGroups(world.OrderBy(i => i.Time));
                newest.HasWorldData = true;
            }
            catch (Exception)
            {
                // still being written; next scan tries again
            }
        }

        var signature = string.Join("|", infos.Select(i => i.Key + (i.HasWorldData ? "+" : "")).OrderBy(s => s, StringComparer.Ordinal));
        if (signature == _lastSignature)
            return;
        _lastSignature = signature;
        _server.OnSaves(infos.OrderBy(i => i.Time).ToList());
    }

    // Same key format as the old Python server, so existing progress.json files carry over.
    private string KeyOf(string path) =>
        $"{Path.GetRelativePath(_dir, path)}@{new DateTimeOffset(File.GetLastWriteTimeUtc(path)).ToUnixTimeSeconds()}";

    private SaveInfo Read(string path, string key)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var zip = new ZipArchive(fs, ZipArchiveMode.Read);
        var player = Inner(zip, "PlayerStateSaveData.json", "PlayerState");
        var setup = Inner(zip, "GameSetupSaveData.json", "GameSetup");
        var game = Inner(zip, "GameStateSaveData.json", "GameState");
        var entries = (player["_entries"] as JsonArray)?.OfType<JsonObject>().ToDictionary(e => e["Name"]?.ToString() ?? "", e => e) ?? new();
        var pos = (JsonArray)entries["player.position"]["FloatArrayValue"];
        var rot = entries.TryGetValue("player.rotation", out var r) ? r["FloatArrayValue"] as JsonArray : null;
        var folder = Path.GetDirectoryName(path);
        var nameFile = Directory.GetFiles(folder, "*.name").FirstOrDefault();
        var label = nameFile != null ? Path.GetFileNameWithoutExtension(nameFile) : Path.GetFileName(folder);
        var parts = label.Split('_');
        var rel = Path.GetRelativePath(_dir, path).Split(Path.DirectorySeparatorChar); // <steamid>\<mode>\<slot>\SaveData.zip
        var fileTime = new DateTimeOffset(File.GetLastWriteTimeUtc(path)).ToUnixTimeMilliseconds() / 1000.0;
        var settings = (setup["_settings"] as JsonArray)?.OfType<JsonObject>().ToList() ?? new();
        string Setting(string name) => settings.FirstOrDefault(s => s["Name"]?.ToString() == name)?["StringValue"]?.ToString();
        var info = new SaveInfo
        {
            Key = key, Path = path, Mode = rel[1], Slot = rel[2],
            Difficulty = game["GameType"]?.ToString() ?? Setting("Mode"),
            X = N(pos[0]), H = N(pos[1]), Z = N(pos[2]),
            Heading = rot is { Count: 4 } ? HeadingFromQuaternion(N(rot[0]), N(rot[1]), N(rot[2]), N(rot[3])) : null,
            World = Setting("UID"),
            Label = label,
            Day = MapServer.TryNum(game["GameDays"], out var days) ? (int)days
                : parts.Length > 2 && int.TryParse(parts[1], out var d) ? d : null,
            Time = DateTimeOffset.TryParse(game["SaveTime"]?.ToString(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var saved)
                ? saved.ToUnixTimeMilliseconds() / 1000.0 : fileTime,
            Changed = ReadChanged(zip),
        };
        return info;
    }

    /// <summary>Save files wrap each section as a JSON string inside {"Data": {"Section": "..."}}.</summary>
    private static JsonObject Inner(ZipArchive zip, string file, string section)
    {
        var entry = zip.GetEntry(file);
        if (entry == null)
            return new JsonObject();
        using var reader = new StreamReader(entry.Open());
        var outer = JsonNode.Parse(reader.ReadToEnd());
        var node = outer?["Data"]?[section];
        if (node is JsonValue v && v.TryGetValue<string>(out var s))
            node = JsonNode.Parse(s);
        return node as JsonObject ?? new JsonObject();
    }

    private static double N(JsonNode n) => MapServer.TryNum(n, out var v) ? v : 0;

    private static (double x, double y, double z) Vec(JsonNode n) => (N(n?["x"]), N(n?["y"]), N(n?["z"]));

    public static double HeadingFromQuaternion(double x, double y, double z, double w)
    {
        var fx = 2 * (x * z + w * y);
        var fz = 1 - 2 * (x * x + y * y);
        return (Math.Atan2(fx, fz) * 180 / Math.PI + 360) % 360;
    }

    // ---------- camps: everything you built, grouped by place ----------

    private JsonArray ReadCamps(ZipArchive zip)
    {
        var pts = new List<(double x, double z, double y, string name)>();
        if (Inner(zip, "ScrewStructureInstancesSaveData.json", "ScrewStructureInstances")["_structures"] is JsonArray screws)
            foreach (var s in screws.OfType<JsonObject>())
            {
                var (x, y, z) = Vec(s["Pos"]);
                var id = (int)N(s["Id"]);
                pts.Add((x, z, y, _structureNames.TryGetValue(id, out var name) ? name : $"Structure {id}"));
            }
        if (Inner(zip, "ConstructionsSaveData.json", "Constructions")["Structures"] is JsonArray groups)
            foreach (var g in groups.OfType<JsonArray>())
                foreach (var s in g.OfType<JsonObject>())
                    if (s["Position"] != null)
                    {
                        var (x, y, z) = Vec(s["Position"]);
                        pts.Add((x, z, y, null)); // log building pieces
                    }

        // single-link clustering: union-find over pairs closer than CampRadius
        var parent = Enumerable.Range(0, pts.Count).ToArray();
        int Find(int i) => parent[i] == i ? i : parent[i] = Find(parent[i]);
        for (var i = 0; i < pts.Count; i++)
            for (var j = i + 1; j < pts.Count; j++)
            {
                double dx = pts[i].x - pts[j].x, dz = pts[i].z - pts[j].z;
                if (dx * dx + dz * dz <= CampRadius * CampRadius)
                    parent[Find(i)] = Find(j);
            }

        var camps = new JsonArray();
        foreach (var group in Enumerable.Range(0, pts.Count).GroupBy(Find).Select(g => g.Select(i => pts[i]).ToList())
                     .Where(g => g.Count >= CampMinPieces).OrderByDescending(g => g.Count))
        {
            var items = group.Where(p => p.name != null).GroupBy(p => p.name)
                .OrderByDescending(g => g.Count()).ThenBy(g => g.Key)
                .Select(g => (JsonNode)new JsonObject { ["n"] = g.Key, ["c"] = g.Count() }).ToArray();
            camps.Add(new JsonObject
            {
                ["x"] = Math.Round(group.Average(p => p.x), 1), ["y"] = Math.Round(group.Average(p => p.z), 1),
                ["h"] = Math.Round(group.Average(p => p.y), 1),
                ["pieces"] = group.Count, ["logs"] = group.Count(p => p.name == null), ["items"] = new JsonArray(items),
            });
        }
        return camps;
    }

    // ---------- vehicles: where every golf cart, Knight V and hang glider is parked, and gliders you put down ----------

    private static readonly Regex VehicleId = new(@"^World\.(GolfCart|KnightV|HangGlider)\.\d+$");

    // ---------- your history: what a save shows about where you've been ----------
    // Most of a save is the state of the world (every village, cave and breakable is in it, visited or not),
    // so only what you did yourself counts:
    //   items      every item id in your inventory (the map marks an item found when it has one spot only)
    //   pois       the game's own "point of interest found" flags, by name ("Bunker Entertainment")
    //   spots      both ends of every zip line you put up
    //   changed    (added by Scan, from every save of the world) where you changed something: ChangedGroups
    internal static JsonObject ReadHistory(ZipArchive zip)
    {
        var items = new SortedSet<int>();
        CollectItemIds(Inner(zip, "PlayerInventorySaveData.json", "PlayerInventory"), items);
        var pois = new JsonArray();
        var player = Inner(zip, "PlayerStateSaveData.json", "PlayerState");
        foreach (var e in (player["_entries"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
        {
            var name = e["Name"]?.ToString() ?? "";
            const string poi = "PointOfInterestFound_";
            if (name.StartsWith(poi, StringComparison.Ordinal) && e["BoolValue"] is JsonValue b && b.TryGetValue<bool>(out var on) && on)
                pois.Add(name[poi.Length..]);
        }
        var spots = new JsonArray();
        if (Inner(zip, "ZipLineManagerSaveData.json", "ZipLineManager")["Ziplines"] is JsonArray lines)
            foreach (var line in lines.OfType<JsonObject>())
                foreach (var end in new[] { "_anchorAPosition", "_anchorBPosition" })
                {
                    var (x, y, z) = Vec(line[end]);
                    if (x != 0 || z != 0)
                        spots.Add(new JsonObject { ["x"] = Math.Round(x, 1), ["y"] = Math.Round(z, 1), ["h"] = Math.Round(y, 1), ["k"] = "zipline" });
                }
        return new JsonObject
        {
            ["items"] = new JsonArray(items.Select(i => (JsonNode)i).ToArray()), ["pois"] = pois, ["spots"] = spots,
        };
    }

    // ---------- what you changed in the world: trees you felled, bushes you picked, things you broke or took ----------
    // WorldObjectLocatorManager keeps one entry for every world object that isn't as it started. The key is
    // where that object is: three little-endian int32s (x, height, z) in 1/4096 m. The value says what
    // happened to it; for the map it only matters that you were there.
    private const double LocatorScale = 4096;
    private const int ChangedCell = 2; // metres; the page needs "you were here", not every stump

    internal static List<(float x, float z, float h)> ReadChanged(ZipArchive zip)
    {
        var list = new List<(float x, float z, float h)>();
        if (Inner(zip, "WorldObjectLocatorManagerSaveData.json", "WorldObjectLocatorManager")["SerializedStates"] is not JsonArray states)
            return list;
        foreach (var s in states.OfType<JsonObject>())
        {
            if (s["Key"]?.ToString() is not { Length: 24 } key)
                continue;
            byte[] b;
            try { b = Convert.FromHexString(key); }
            catch (FormatException) { continue; }
            double x = BinaryPrimitives.ReadInt32LittleEndian(b.AsSpan(0)) / LocatorScale;
            double h = BinaryPrimitives.ReadInt32LittleEndian(b.AsSpan(4)) / LocatorScale;
            double z = BinaryPrimitives.ReadInt32LittleEndian(b.AsSpan(8)) / LocatorScale;
            list.Add(((float)x, (float)z, (float)h));
        }
        return list;
    }

    /// <summary>
    /// Every save of a world adds to what you changed (old saves still count when newer ones are gone).
    /// One group per save, oldest first, with only the spots that first show up in it, in 2 m cells:
    /// [{ "t": save time, "p": [x, z, height, x, z, height, ...] }]. So a page only looks at what's new.
    /// </summary>
    internal static JsonArray ChangedGroups(IEnumerable<SaveInfo> saves)
    {
        var cells = new HashSet<(int, int, int)>();
        var groups = new JsonArray();
        foreach (var save in saves)
        {
            var pts = new List<JsonNode>();
            foreach (var (x, z, h) in save.Changed)
            {
                int cx = (int)Math.Floor(x / ChangedCell), cz = (int)Math.Floor(z / ChangedCell);
                if (!cells.Add((cx, cz, (int)Math.Floor(h / 8)))) // a cave under a felled tree is another spot
                    continue;
                pts.Add(cx * ChangedCell + ChangedCell / 2); // the middle of the cell
                pts.Add(cz * ChangedCell + ChangedCell / 2);
                pts.Add((int)Math.Round(h));
            }
            if (pts.Count > 0)
                groups.Add(new JsonObject { ["t"] = save.Time, ["p"] = new JsonArray(pts.ToArray()) });
        }
        return groups;
    }

    private static void CollectItemIds(JsonNode node, SortedSet<int> into)
    {
        switch (node)
        {
            case JsonObject o:
                foreach (var (k, v) in o)
                {
                    if (k == "ItemId" && MapServer.TryNum(v, out var id) && id > 0)
                        into.Add((int)id);
                    else
                        CollectItemIds(v, into);
                }
                break;
            case JsonArray a:
                foreach (var v in a)
                    CollectItemIds(v, into);
                break;
        }
    }

    private const int GliderItemId = 626; // the game's item id for a hang glider, if no World.HangGlider says otherwise

    private static JsonArray ReadVehicles(ZipArchive zip)
    {
        var list = new JsonArray();
        if (Inner(zip, "WorldItemManagerSaveData.json", "WorldItemManager")["WorldItemStates"] is not JsonArray states)
            return list;
        // A glider can be folded up and carried. The island's own (World.HangGlider.N) stay listed where they
        // start even after you take one; one you put down yourself has an id of its own (a guid), with no
        // position while it's in your inventory.
        var gliderItems = states.OfType<JsonObject>()
            .Where(s => s["ObjectNameId"]?.ToString()?.StartsWith("World.HangGlider.", StringComparison.Ordinal) == true)
            .Select(s => (int)N(s["ItemId"])).Where(i => i > 0).ToHashSet();
        if (gliderItems.Count == 0)
            gliderItems.Add(GliderItemId);
        foreach (var s in states.OfType<JsonObject>())
        {
            var id = s["ObjectNameId"]?.ToString() ?? "";
            var m = VehicleId.Match(id);
            if (!m.Success)
            {
                var (gx, gy, gz) = Vec(s["Position"]);
                if (!id.StartsWith("World.", StringComparison.Ordinal) && gliderItems.Contains((int)N(s["ItemId"])) && Math.Abs(gx) + Math.Abs(gz) > 1)
                    list.Add(new JsonObject
                    {
                        ["id"] = id, ["k"] = "glider", ["mine"] = true,
                        ["x"] = Math.Round(gx, 2), ["y"] = Math.Round(gz, 2), ["h"] = Math.Round(gy, 1),
                        ["heading"] = Math.Round((N(s["Rotation"]?["y"]) % 360 + 360) % 360, 1),
                    });
                continue;
            }
            var (x, y, z) = Vec(s["Position"]);
            list.Add(new JsonObject
            {
                ["id"] = id,
                ["k"] = m.Groups[1].Value switch { "GolfCart" => "cart", "KnightV" => "knightv", _ => "glider" },
                ["x"] = Math.Round(x, 2), ["y"] = Math.Round(z, 2), ["h"] = Math.Round(y, 1),
                ["heading"] = Math.Round((N(s["Rotation"]?["y"]) % 360 + 360) % 360, 1), // saved as euler degrees
            });
        }
        return list;
    }
}
