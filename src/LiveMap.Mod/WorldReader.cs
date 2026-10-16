using System.Globalization;
using System.Text;
using Il2Cpp;
using Il2CppEndnight.Utilities;
using Il2CppSons.Ai.Vail;
using Il2CppSons.Gameplay.GPS;
using UnityEngine;

namespace LiveMap;

/// <summary>
/// Reads (never changes) what the map shows besides you: Kelvin and Virginia, other players in co-op,
/// and the markers on your in-game GPS (trackers you placed, tracker darts, GPS locators).
/// Each section is guarded on its own, so one that fails (e.g. after a game update) doesn't stop the rest.
/// </summary>
internal sealed class WorldReader
{
    private readonly HashSet<string> _failed = new();
    public readonly List<string> Problems = new();

    public void AppendOthers(StringBuilder sb)
    {
        sb.Append(",\"others\":[");
        var first = true;
        Guard("companions", () => Companions(sb, ref first));
        Guard("players", () => Players(sb, ref first));
        sb.Append(']');
    }

    public void AppendTags(StringBuilder sb)
    {
        sb.Append(",\"tags\":[");
        var first = true;
        Guard("GPS tags", () => Tags(sb, ref first));
        sb.Append(']');
    }

    private delegate void Section();

    private void Guard(string name, Section section)
    {
        try
        {
            section();
        }
        catch (Exception e)
        {
            if (_failed.Add(name))
                Problems.Add($"Could not read {name} (will keep trying): {e.Message}");
        }
    }

    // ---------- Kelvin and Virginia ----------

    private static void Companions(StringBuilder sb, ref bool first)
    {
        var count = 0;
        var sim = VailWorldSimulation._instance;
        if (sim)
        {
            count += SimActors(sb, ref first, sim._robbyActors, "kelvin");
            count += SimActors(sb, ref first, sim._virginiaActors, "virginia");
        }
        if (count > 0)
            return;
        // Co-op clients don't run the world simulation; use the companions spawned near you instead.
        var manager = VailActorManager._instance;
        if (!manager || manager._activeActors == null)
            return;
        var actors = manager._activeActors;
        for (var i = 0; i < actors.Count; i++)
        {
            var a = actors[i];
            if (!a)
                continue;
            var kind = a.TypeId == VailActorTypeId.Robby ? "kelvin" : a.TypeId == VailActorTypeId.Virginia ? "virginia" : null;
            if (kind == null)
                continue;
            var t = a.transform;
            Entry(sb, ref first, kind, null, null, t.position, Heading(t.forward), a.IsDead(), 0);
        }
    }

    private static int SimActors(StringBuilder sb, ref bool first, Il2CppSystem.Collections.Generic.List<WorldSimActor> list, string kind)
    {
        if (list == null)
            return 0;
        var n = 0;
        for (var i = 0; i < list.Count; i++)
        {
            var a = list[i];
            if (a == null || !a.PositionIsValid())
                continue;
            Vector3 pos;
            float heading;
            var real = VailActorManager.FindActiveActor(a); // the spawned actor moves smoothly; the simulated one updates in steps
            if (real)
            {
                var t = real.transform;
                pos = t.position;
                heading = Heading(t.forward);
            }
            else
            {
                pos = a.Position();
                var q = a.Rotation();
                heading = Heading(new Vector3(2 * (q.x * q.z + q.w * q.y), 0, 1 - 2 * (q.x * q.x + q.y * q.y)));
            }
            Entry(sb, ref first, kind, null, null, pos, heading, a.IsDead(), (int)a.AreaMask);
            n++;
        }
        return n;
    }

    // ---------- other players (co-op) ----------

    private static void Players(StringBuilder sb, ref bool first)
    {
        var players = PlayerLocation._players;
        if (players == null)
            return;
        for (var i = 0; i < players.Count; i++)
        {
            var p = players[i];
            if (!p || p.IsLocalPlayer)
                continue;
            var t = p.transform;
            string name = null;
            string color = null;
            try
            {
                var state = p.state;
                if (state != null)
                {
                    name = BoltPlayerSetup.GetPlayerName(p.entity, state);
                    if (string.IsNullOrWhiteSpace(name))
                        name = state.name;
                    var c = state.PlayerColor;
                    color = Hex(c);
                }
            }
            catch (Exception)
            {
                // name and colour are extras; the position is what matters
            }
            Entry(sb, ref first, "player", string.IsNullOrWhiteSpace(name) ? "Player" : name, color, t.position, Heading(t.forward), false, p.AreaMask);
        }
    }

    // ---------- GPS markers ----------

    private static void Tags(StringBuilder sb, ref bool first)
    {
        var locators = GPSLocator._activeLocators;
        if (locators == null)
            return;
        for (var i = 0; i < locators.Count && i < 64; i++)
        {
            var l = locators[i];
            if (!l || !l.IsActive || l.UIStyle == GPSLocator.Style.PlayerPin)
                continue; // players are sent with their names above
            var pos = l.Position();
            string color = null;
            try
            {
                var icon = l.IconData;
                if (icon != null)
                    color = Hex(icon._iconColor);
            }
            catch (Exception)
            {
                // colour is optional
            }
            var text = l._pointOfInterestName;
            if (string.IsNullOrWhiteSpace(text))
                text = l.Text;
            if (text != null && text.Trim().Length < 2)
                text = null; // the GPS shows a letter ("P") for most markers; the map names them by icon type
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"x\":").Append(F(pos.x)).Append(",\"y\":").Append(F(pos.y)).Append(",\"z\":").Append(F(pos.z))
              .Append(",\"i\":").Append(l.CurrentIconId)
              .Append(",\"a\":").Append(l._worldActorId != 0 ? "true" : "false");
            if (color != null) sb.Append(",\"c\":").Append(Str(color));
            if (!string.IsNullOrWhiteSpace(text)) sb.Append(",\"t\":").Append(Str(text));
            sb.Append('}');
        }
    }

    // ---------- JSON helpers ----------

    private static void Entry(StringBuilder sb, ref bool first, string kind, string name, string color, Vector3 pos, float heading, bool dead, int area)
    {
        if (!first) sb.Append(',');
        first = false;
        sb.Append("{\"k\":").Append(Str(kind));
        if (name != null) sb.Append(",\"n\":").Append(Str(name));
        if (color != null) sb.Append(",\"c\":").Append(Str(color));
        sb.Append(",\"x\":").Append(F(pos.x)).Append(",\"y\":").Append(F(pos.y)).Append(",\"z\":").Append(F(pos.z))
          .Append(",\"heading\":").Append(F(heading)).Append(",\"dead\":").Append(dead ? "true" : "false")
          .Append(",\"area\":").Append(area).Append('}');
    }

    public static float Heading(Vector3 fwd)
    {
        var h = MathF.Atan2(fwd.x, fwd.z) * (180f / MathF.PI); // 0 = +Z (north), clockwise toward +X (east)
        return h < 0 ? h + 360f : h;
    }

    public static string F(float v) => float.IsFinite(v) ? v.ToString("0.0#", CultureInfo.InvariantCulture) : "0";

    private static string Hex(Color c) =>
        $"#{(int)(Mathf.Clamp01(c.r) * 255):x2}{(int)(Mathf.Clamp01(c.g) * 255):x2}{(int)(Mathf.Clamp01(c.b) * 255):x2}";

    public static string Str(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (var ch in s.Length > 60 ? s[..60] : s)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                default:
                    if (ch < ' ') sb.Append($"\\u{(int)ch:x4}");
                    else sb.Append(ch);
                    break;
            }
        }
        return sb.Append('"').ToString();
    }
}
