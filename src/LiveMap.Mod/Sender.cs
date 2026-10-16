using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace LiveMap;

/// <summary>
/// Sends updates from a background thread so the game never waits on the network.
/// Only the newest update is kept: if the map is slow or closed, older ones are dropped, never queued.
/// </summary>
internal sealed class Sender
{
    private const int RetryDelayMs = 3000;

    /// <summary>Status lines for the main thread to log (state changes only, never per request).</summary>
    public readonly ConcurrentQueue<string> Messages = new();

    private readonly Uri _url;
    private readonly HttpClient _http;
    private readonly AutoResetEvent _wake = new(false);
    private string _pending;
    private bool? _reachable;

    public Sender(Uri url)
    {
        _url = url;
        _http = new HttpClient(new SocketsHttpHandler { UseProxy = false, ConnectTimeout = TimeSpan.FromMilliseconds(500) })
        {
            Timeout = TimeSpan.FromSeconds(1),
        };
        new Thread(Run) { IsBackground = true, Name = "LiveMap.Sender" }.Start();
    }

    /// <summary>Where "Guide me here" points (set on the map), or null. Updated with every reply from the map.</summary>
    public volatile GuideTarget Target;

    private void ReadTarget(string reply)
    {
        try
        {
            using var doc = JsonDocument.Parse(reply);
            if (!doc.RootElement.TryGetProperty("target", out var t) || t.ValueKind != JsonValueKind.Object)
            {
                Target = null;
                return;
            }
            Target = new GuideTarget
            {
                X = t.GetProperty("x").GetSingle(),
                Z = t.GetProperty("y").GetSingle(), // the map's y is the game's z
                H = t.TryGetProperty("h", out var h) && h.ValueKind == JsonValueKind.Number ? h.GetSingle() : null,
                Label = t.TryGetProperty("label", out var l) ? l.GetString() ?? "Target" : "Target",
            };
        }
        catch (Exception)
        {
            // an older map that doesn't send targets
        }
    }

    public void Send(string json)
    {
        Interlocked.Exchange(ref _pending, json);
        _wake.Set();
    }

    private void Run()
    {
        while (true)
        {
            _wake.WaitOne();
            var body = Interlocked.Exchange(ref _pending, null);
            if (body == null)
                continue;

            string problem = null;
            try
            {
                using var content = new StringContent(body, Encoding.UTF8, "application/json");
                using var response = _http.PostAsync(_url, content).GetAwaiter().GetResult();
                if (!response.IsSuccessStatusCode)
                    problem = $"map answered HTTP {(int)response.StatusCode}";
                else
                    ReadTarget(response.Content.ReadAsStringAsync().GetAwaiter().GetResult());
            }
            catch (Exception)
            {
                problem = "map not reachable";
            }

            var ok = problem == null;
            if (_reachable != ok)
            {
                Messages.Enqueue(ok ? $"Connected to the map at {_url}" : $"{problem} at {_url}. Retrying quietly every few seconds.");
                _reachable = ok;
            }
            if (!ok)
                Thread.Sleep(RetryDelayMs);
        }
    }
}

internal sealed class GuideTarget
{
    public float X, Z;
    public float? H;
    public string Label;
}
