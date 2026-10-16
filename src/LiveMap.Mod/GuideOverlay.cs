using Il2CppTheForest.Utils;
using UnityEngine;

namespace LiveMap;

/// <summary>
/// The in-game arrow for "Guide me here": a small strip at the top of the screen with an arrow that
/// turns with you, the target's name, the distance and the direction. Drawn with Unity's IMGUI as an
/// overlay only; the game's own GPS, markers and saves are never touched.
/// </summary>
internal sealed class GuideOverlay
{
    private const float ArrivedMetres = 10f;
    private static readonly string[] Compass = { "N", "NE", "E", "SE", "S", "SW", "W", "NW" };

    private Texture2D _arrow, _panel;
    private GUIStyle _text, _shadow;

    public bool Visible = true;

    // The strip's text is only made again when what it says changes (not every frame).
    private string _shown;
    private string _shownLabel;
    private int _shownMetres = -1, _shownCompass = -1, _shownHeight, _shownFont;
    private bool _shownArrived;
    private float _textWidth;
    private GUIContent _content;

    public void Draw(GuideTarget target)
    {
        // OnGUI runs several times a frame (layout, input, repaint); the strip only needs the repaint.
        if (!Visible || target == null || Event.current.type != EventType.Repaint || !LocalPlayer.IsInWorld)
            return;
        var tr = LocalPlayer.Transform;
        if (!tr)
            return;
        EnsureResources();

        var pos = tr.position;
        float dx = target.X - pos.x, dz = target.Z - pos.z;
        var dist = MathF.Sqrt(dx * dx + dz * dz);
        var bearing = (MathF.Atan2(dx, dz) * 180f / MathF.PI + 360f) % 360f;
        var turn = bearing - WorldReader.Heading(tr.forward); // degrees clockwise from where you look
        var arrived = dist < ArrivedMetres;

        var scale = Mathf.Clamp(Screen.height / 1080f, 0.75f, 2f);
        var font = (int)(20 * scale);
        var metres = (int)MathF.Round(dist);
        var compass = (int)MathF.Round(bearing / 45f) % 8;
        var climb = target.H is { } h && MathF.Abs(h - pos.y) > 12f ? (int)MathF.Round(h - pos.y) : 0;
        if (_shown == null || metres != _shownMetres || compass != _shownCompass || climb != _shownHeight || arrived != _shownArrived
            || font != _shownFont || target.Label != _shownLabel)
        {
            var line = arrived ? $"Arrived · {target.Label}" : $"{target.Label} · {Metres(dist)} · {Compass[compass]}";
            if (climb != 0)
                line += climb > 0 ? $" · {Metres(climb)} above" : $" · {Metres(-climb)} below";
            _text.fontSize = _shadow.fontSize = font;
            _content.text = line;
            _textWidth = _text.CalcSize(_content).x;
            (_shown, _shownLabel, _shownMetres, _shownCompass, _shownHeight, _shownArrived, _shownFont) = (line, target.Label, metres, compass, climb, arrived, font);
        }
        var text = _shown;
        var textWidth = _textWidth;
        var arrowSize = 30f * scale;
        var pad = 12f * scale;
        var width = pad + arrowSize + pad + textWidth + pad * 1.5f;
        var height = 46f * scale;
        var x = (Screen.width - width) / 2f;
        var y = 14f * scale;

        GUI.DrawTexture(new Rect(x, y, width, height), _panel);

        var cx = x + pad + arrowSize / 2f;
        var cy = y + height / 2f;
        var arrowColor = arrived ? new Color(0.5f, 0.86f, 0.56f, 1f) : new Color(1f, 0.82f, 0.4f, 1f);
        var oldColor = GUI.color;
        GUI.color = arrowColor;
        if (arrived)
        {
            GUI.DrawTexture(new Rect(cx - arrowSize * 0.28f, cy - arrowSize * 0.28f, arrowSize * 0.56f, arrowSize * 0.56f), _panelDot);
        }
        else
        {
            var matrix = GUI.matrix;
            GUIUtility.RotateAroundPivot(turn, new Vector2(cx, cy));
            GUI.DrawTexture(new Rect(cx - arrowSize / 2f, cy - arrowSize / 2f, arrowSize, arrowSize), _arrow);
            GUI.matrix = matrix;
        }
        GUI.color = oldColor;

        var textRect = new Rect(x + pad + arrowSize + pad, y, textWidth + pad, height);
        GUI.Label(new Rect(textRect.x + 1.5f * scale, textRect.y + 1.5f * scale, textRect.width, textRect.height), text, _shadow);
        _text.normal.textColor = arrived ? arrowColor : Color.white;
        GUI.Label(textRect, text, _text);
    }

    private static string Metres(float m) => m >= 1000f ? $"{m / 1000f:0.0} km" : $"{MathF.Round(m)} m";

    private Texture2D _panelDot;

    private void EnsureResources()
    {
        if (!_arrow)
            _arrow = MakeArrow(64);
        if (!_panel)
            _panel = Solid(new Color(0.06f, 0.08f, 0.07f, 0.72f));
        if (!_panelDot)
            _panelDot = MakeDot(32);
        _content ??= new GUIContent();
        if (_text == null)
        {
            _text = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleLeft, fontStyle = FontStyle.Bold, wordWrap = false };
            _shadow = new GUIStyle(_text);
            _shadow.normal.textColor = new Color(0, 0, 0, 0.8f);
        }
    }

    private static Texture2D Solid(Color c)
    {
        var t = new Texture2D(1, 1, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave };
        t.SetPixel(0, 0, c);
        t.Apply();
        return t;
    }

    /// <summary>A white arrow pointing up (drawn tinted and rotated).</summary>
    private static Texture2D MakeArrow(int n)
    {
        var t = new Texture2D(n, n, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave, filterMode = FilterMode.Bilinear };
        for (var py = 0; py < n; py++)
        {
            for (var px = 0; px < n; px++)
            {
                // texture rows start at the bottom: v = 1 is the tip
                float u = (px + 0.5f) / n - 0.5f, v = (py + 0.5f) / n;
                var halfWidth = 0.42f * (1f - v);                     // triangle from the base (v=0) to the tip (v=1)
                var notch = v < 0.32f && MathF.Abs(u) < 0.32f * (0.32f - v) / 0.32f * 1.4f; // cut-out at the back
                var a = v > 0.04f && v < 0.98f && MathF.Abs(u) <= halfWidth && !notch ? 1f : 0f;
                t.SetPixel(px, py, new Color(1, 1, 1, a));
            }
        }
        t.Apply();
        return t;
    }

    private static Texture2D MakeDot(int n)
    {
        var t = new Texture2D(n, n, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave, filterMode = FilterMode.Bilinear };
        var r = n / 2f;
        for (var py = 0; py < n; py++)
            for (var px = 0; px < n; px++)
            {
                var d = MathF.Sqrt((px + 0.5f - r) * (px + 0.5f - r) + (py + 0.5f - r) * (py + 0.5f - r));
                t.SetPixel(px, py, new Color(1, 1, 1, Mathf.Clamp01(r - d)));
            }
        t.Apply();
        return t;
    }
}
