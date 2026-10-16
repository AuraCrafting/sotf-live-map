using System.Diagnostics;
using System.Net.Sockets;
using System.Text;
using LiveMap;
using Il2CppEndnight.Utilities;
using Il2CppSons.Gameplay.GameSetup;
using Il2CppTheForest.Utils;
using MelonLoader;
using MelonLoader.Utils;
using UnityEngine;

[assembly: MelonInfo(typeof(LiveMapMod), "SOTF Live Map", "3.3.1", "AuraCrafting")]
[assembly: MelonGame("Endnight", "SonsOfTheForest")]
[assembly: HarmonyDontPatchAll]

namespace LiveMap;

/// <summary>
/// Feeds the SOTF Live Map: your live position and heading, whether you're in a cave or bunker,
/// Kelvin and Virginia, other players in co-op, and your in-game GPS markers.
/// Read-only: no Harmony patches, no console commands or cheats, no game settings, nothing in saves,
/// nothing sent over the game's network.
/// </summary>
public class LiveMapMod : MelonMod
{
    private const float SampleInterval = 0.5f; // about 2 updates per second
    private const float Heartbeat = 5f;         // resend while nothing changes; the map drops "Live" after ~15 s
    private const float MinMove = 0.25f;        // metres
    private const float MinTurn = 2f;           // degrees

    private Sender _sender;
    private readonly WorldReader _world = new();
    private readonly GuideOverlay _guide = new();
    private KeyCode _guideKey = KeyCode.F8;
    private float _nextSample;
    private float _lastSent = float.NegativeInfinity;
    private float _lastX, _lastY, _lastZ, _lastHeading;
    private string _lastExtras = "";
    private bool _errorLogged;
    private bool _saveErrorLogged;
    private bool _guideErrorLogged;

    public override void OnInitializeMelon()
    {
        var prefs = MelonPreferences.CreateCategory("LiveMap", "SOTF Live Map");
        var port = prefs.CreateEntry("Port", 8765, "Map port", "Port of the map (SOTF Live Map.exe --port).");
        var autoStart = prefs.CreateEntry("AutoStartMap", true, "Start the map with the game",
            "Start SOTF Live Map.exe when the game starts, unless the map is already running.");
        var mapExe = prefs.CreateEntry("MapExe", "", "Map program",
            "Leave empty to use SOTFLiveMap\\SOTF Live Map.exe in the game folder.");

        var showGuide = prefs.CreateEntry("ShowGuide", true, "Show the guide arrow",
            "Show the in-game arrow when you pick \"Guide me here\" on the map.");
        var guideKey = prefs.CreateEntry("GuideKey", "F8", "Guide arrow key", "Key that hides or shows the guide arrow (a Unity KeyCode name).");
        // read by the map app, not by the mod (Updates.cs); here so it shows up in MelonPreferences.cfg
        prefs.CreateEntry("CheckForUpdates", true, "Check for updates",
            "Let the map look on GitHub for a newer version (one small request at start and every few hours). It never installs by itself: you press Update on the map page.");
        _guide.Visible = showGuide.Value;
        if (Enum.TryParse<KeyCode>(guideKey.Value, true, out var key))
            _guideKey = key;

        _sender = new Sender(new Uri($"http://127.0.0.1:{port.Value}/api/position"));
        LoggerInstance.Msg($"Sending your live position to the map on port {port.Value} while you are in the world");

        if (autoStart.Value)
        {
            var exe = string.IsNullOrWhiteSpace(mapExe.Value)
                ? Path.Combine(MelonEnvironment.GameRootDirectory, "SOTFLiveMap", "SOTF Live Map.exe")
                : mapExe.Value;
            var p = port.Value;
            Task.Run(() =>
            {
                try { _sender.Messages.Enqueue(StartMap(exe, p)); }
                catch (Exception e) { _sender.Messages.Enqueue($"Could not start the map: {e.Message}"); }
            });
        }
    }

    /// <summary>
    /// Starts the map unless it's already running. It is launched through Explorer so it isn't part of
    /// the game process: Steam would otherwise keep showing the game as running while the map is open.
    /// </summary>
    private static string StartMap(string exe, int port)
    {
        try
        {
            using var probe = new TcpClient();
            if (probe.ConnectAsync("127.0.0.1", port).Wait(500) && probe.Connected)
                return "The map is already running";
        }
        catch (Exception)
        {
            // not running
        }
        if (!File.Exists(exe))
            return $"Map not found at {exe}. Run Install.bat again, or set MapExe in UserData\\MelonPreferences.cfg";
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{exe}\"") { UseShellExecute = false })?.Dispose();
        return $"Started the map ({exe})";
    }

    public override void OnGUI()
    {
        try
        {
            _guide.Draw(_sender.Target);
        }
        catch (Exception e)
        {
            if (!_guideErrorLogged)
                LoggerInstance.Warning($"Could not draw the guide arrow: {e.Message}");
            _guideErrorLogged = true;
        }
    }

    public override void OnUpdate()
    {
        while (_sender.Messages.TryDequeue(out var message))
            LoggerInstance.Msg(message);
        if (_sender.Target != null && Input.GetKeyDown(_guideKey))
            _guide.Visible = !_guide.Visible;
        foreach (var problem in _world.Problems)
            LoggerInstance.Warning(problem);
        _world.Problems.Clear();

        var now = Time.unscaledTime;
        if (now < _nextSample)
            return;
        _nextSample = now + SampleInterval;

        try
        {
            Sample(now);
        }
        catch (Exception e)
        {
            if (!_errorLogged)
                LoggerInstance.Warning($"Could not read your position (will keep trying): {e.Message}");
            _errorLogged = true;
        }
    }

    private void Sample(float now)
    {
        if (!LocalPlayer.IsInWorld)
            return;
        var tr = LocalPlayer.Transform;
        if (!tr)
            return;

        var pos = tr.position;
        var heading = WorldReader.Heading(tr.forward);
        var cave = LocalPlayer.IsInCaves; // the game's own flag; also see area below
        var area = 0;
        try { area = PlayerLocation.GetLocalPlayerAreaMask(); } catch (Exception) { /* optional */ }

        var extras = new StringBuilder();
        AppendSave(extras);
        _world.AppendOthers(extras);
        _world.AppendTags(extras);
        var extrasJson = extras.ToString();

        float dx = pos.x - _lastX, dy = pos.y - _lastY, dz = pos.z - _lastZ;
        var moved = dx * dx + dy * dy + dz * dz >= MinMove * MinMove;
        var turned = MathF.Abs(DeltaAngle(heading, _lastHeading)) >= MinTurn;
        var othersChanged = extrasJson != _lastExtras;
        if (!moved && !turned && !othersChanged && now - _lastSent < Heartbeat)
            return;

        _lastX = pos.x;
        _lastY = pos.y;
        _lastZ = pos.z;
        _lastHeading = heading;
        _lastExtras = extrasJson;
        _lastSent = now;

        var json = new StringBuilder(256 + extrasJson.Length)
            .Append("{\"x\":").Append(WorldReader.F(pos.x)).Append(",\"y\":").Append(WorldReader.F(pos.y))
            .Append(",\"z\":").Append(WorldReader.F(pos.z)).Append(",\"heading\":").Append(WorldReader.F(heading))
            .Append(",\"cave\":").Append(cave ? "true" : "false").Append(",\"area\":").Append(area)
            .Append(extrasJson).Append('}');
        _sender.Send(json.ToString());
    }

    /// <summary>Which world and save slot is loaded, so the map shows that world straight away (without saving first).</summary>
    private void AppendSave(StringBuilder sb)
    {
        try
        {
            var uid = GameSetupManager.GetSetting("UID", "");
            if (string.IsNullOrEmpty(uid))
                uid = GameSetupManager.GetGameId();
            if (!string.IsNullOrEmpty(uid))
                sb.Append(",\"world\":").Append(WorldReader.Str(uid));
            sb.Append(",\"save\":{\"mode\":").Append(WorldReader.Str(GameSetupManager.GetSaveGameType().ToString()))
              .Append(",\"id\":").Append(GameSetupManager.GetSelectedSaveId()).Append('}');
            var difficulty = GameSetupManager.GetSetting("Mode", "");
            if (!string.IsNullOrEmpty(difficulty))
                sb.Append(",\"difficulty\":").Append(WorldReader.Str(difficulty));
        }
        catch (Exception e)
        {
            if (!_saveErrorLogged)
                LoggerInstance.Warning($"Could not read which save is loaded (the map will use your newest save): {e.Message}");
            _saveErrorLogged = true;
        }
    }

    private static float DeltaAngle(float a, float b)
    {
        var d = (a - b) % 360f;
        if (d > 180f) d -= 360f;
        if (d < -180f) d += 360f;
        return d;
    }
}
