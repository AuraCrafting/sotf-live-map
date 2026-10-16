using System.Text.Json.Nodes;

namespace LiveMap;

/// <summary>One bit per cell of a cave or bunker outline (cell k of <see cref="UndergroundArea"/>), lowest bit first.</summary>
public sealed class CellSet
{
    private readonly byte[] _bits;

    public CellSet(int count) => _bits = new byte[(count + 7) / 8];

    public static CellSet FromBase64(string text, int count)
    {
        var set = new CellSet(count);
        try
        {
            var bytes = Convert.FromBase64String(text ?? "");
            if (bytes.Length == set._bits.Length)
                bytes.CopyTo(set._bits, 0);
        }
        catch (FormatException)
        {
            // damaged: this cave starts fogged again rather than fail
        }
        return set;
    }

    public string ToBase64() => Convert.ToBase64String(_bits);
    public bool Has(int k) => (_bits[k >> 3] & (1 << (k & 7))) != 0;
    public int Count => _bits.Sum(b => System.Numerics.BitOperations.PopCount(b));

    /// <summary>True when the cell wasn't set yet.</summary>
    public bool Set(int k)
    {
        if (Has(k))
            return false;
        _bits[k >> 3] |= (byte)(1 << (k & 7));
        return true;
    }

    public void Add(CellSet other)
    {
        for (var k = 0; k < _bits.Length && k < other._bits.Length; k++)
            _bits[k] |= other._bits[k];
    }
}

/// <summary>
/// A cave or bunker as web/data/underground.js has it: its outline as 2 m cells, each with the floor's height
/// (a cave can have several floors over the same spot). Cell k is the k-th cell in that file.
/// </summary>
public sealed class UndergroundArea
{
    public string Id;
    public double Cell, X0, Z0, X1, Z1;
    public float[] X, Z, Y;
    private readonly Dictionary<(int, int), List<int>> _at = new();

    public int Count => X.Length;

    /// <summary>All areas, or none when the file is missing or unreadable.</summary>
    public static List<UndergroundArea> Load(string path)
    {
        var list = new List<UndergroundArea>();
        try
        {
            const string prefix = "window.SOTF_UNDERGROUND = ";
            var line = File.ReadLines(path).FirstOrDefault(l => l.StartsWith(prefix, StringComparison.Ordinal));
            if (line == null || JsonNode.Parse(line[prefix.Length..].TrimEnd().TrimEnd(';')) is not JsonArray areas)
                return list;
            foreach (var a in areas.OfType<JsonObject>())
            {
                if (a["cells"] is not JsonArray cells || a["bounds"] is not JsonArray b || b.Count < 4)
                    continue;
                var area = new UndergroundArea
                {
                    Id = a["id"]?.ToString(), Cell = MapServer.TryNum(a["cell"], out var c) && c > 0 ? c : 2,
                    X0 = Num(b[0]), Z0 = Num(b[1]), X1 = Num(b[2]), Z1 = Num(b[3]),
                    X = new float[cells.Count], Z = new float[cells.Count], Y = new float[cells.Count],
                };
                for (var k = 0; k < cells.Count; k++)
                {
                    var cell = cells[k] as JsonArray;
                    area.X[k] = (float)Num(cell?[0]); area.Z[k] = (float)Num(cell?[1]); area.Y[k] = (float)Num(cell?[2]);
                    var key = ((int)Math.Round(area.X[k] / area.Cell), (int)Math.Round(area.Z[k] / area.Cell));
                    if (!area._at.TryGetValue(key, out var at))
                        area._at[key] = at = new List<int>();
                    at.Add(k);
                }
                if (area.Id != null)
                    list.Add(area);
            }
        }
        catch (Exception)
        {
            // no outlines: caves and bunkers just have no fog
        }
        return list;
    }

    private static double Num(JsonNode n) => MapServer.TryNum(n, out var v) ? v : 0;

    public bool Covers(double x, double z, double margin) => x >= X0 - margin && x <= X1 + margin && z >= Z0 - margin && z <= Z1 + margin;

    /// <summary>The cells within r metres of (x, z), and within dy of height h (any height when h is unknown).</summary>
    public IEnumerable<int> Near(double x, double z, double? h, double r, double dy)
    {
        var reach = (int)Math.Ceiling(r / Cell);
        int cx = (int)Math.Round(x / Cell), cz = (int)Math.Round(z / Cell);
        for (var dx = -reach; dx <= reach; dx++)
            for (var dz = -reach; dz <= reach; dz++)
            {
                if (!_at.TryGetValue((cx + dx, cz + dz), out var at))
                    continue;
                foreach (var k in at)
                {
                    double ex = X[k] - x, ez = Z[k] - z;
                    if (ex * ex + ez * ez <= r * r && (h == null || Math.Abs(Y[k] - h.Value) <= dy))
                        yield return k;
                }
            }
    }

    /// <summary>The floor height at a spot (the nearest cell within 6 m), like the page's floorHeight.</summary>
    public double? FloorAt(double x, double z)
    {
        double best = double.MaxValue;
        double? y = null;
        foreach (var k in Near(x, z, null, 6, 0))
        {
            double d = (X[k] - x) * (X[k] - x) + (Z[k] - z) * (Z[k] - z);
            if (d < best) { best = d; y = Y[k]; }
        }
        return y;
    }
}

/// <summary>
/// Where you've been in one world, for Explore's fog: one bit per 10 m cell over the island (the map's
/// tiles cover x and z from -2000 to 2000, so 400 x 400 cells, 20 KB). It's kept apart from the trail, so
/// thinning or clearing the trail never brings fog back. Cell (i, j) covers x from -2000 + 10 i and z from
/// -2000 + 10 j; its bit is number j * 400 + i, lowest bit first in each byte.
/// </summary>
public sealed class ExploredGrid
{
    public const int Cell = 10;
    public const int Min = -2000;
    public const int Size = 400;

    private readonly byte[] _bits = new byte[Size * Size / 8];

    public static ExploredGrid FromBase64(string text)
    {
        var grid = new ExploredGrid();
        try
        {
            var bytes = Convert.FromBase64String(text ?? "");
            if (bytes.Length == grid._bits.Length)
                bytes.CopyTo(grid._bits, 0);
        }
        catch (FormatException)
        {
            // damaged: start this world's fog again rather than fail
        }
        return grid;
    }

    public string ToBase64() => Convert.ToBase64String(_bits);

    public ExploredGrid Clone()
    {
        var copy = new ExploredGrid();
        _bits.CopyTo(copy._bits, 0);
        return copy;
    }

    public bool Has(int index) => (_bits[index >> 3] & (1 << (index & 7))) != 0;

    /// <summary>Marks one cell as explored (on) or not. True when it changed.</summary>
    public bool Set(int index, bool on)
    {
        if (Has(index) == on)
            return false;
        if (on)
            _bits[index >> 3] |= (byte)(1 << (index & 7));
        else
            _bits[index >> 3] &= (byte)~(1 << (index & 7));
        return true;
    }

    public int Count => _bits.Sum(b => System.Numerics.BitOperations.PopCount(b));

    /// <summary>Adds every cell another grid has (Undo after a reset keeps what you explored since).</summary>
    public void Add(ExploredGrid other)
    {
        for (var k = 0; k < _bits.Length; k++)
            _bits[k] |= other._bits[k];
    }

    /// <summary>
    /// Marks every cell whose middle is within r metres of (x, z) as explored. Returns the cells that weren't
    /// yet, added to <paramref name="into"/> when given.
    /// </summary>
    public List<int> Reveal(double x, double z, double r, List<int> into = null)
    {
        into ??= new List<int>();
        if (double.IsNaN(x) || double.IsNaN(z) || r <= 0)
            return into;
        int i0 = Math.Max(0, (int)Math.Floor((x - r - Min) / Cell)), i1 = Math.Min(Size - 1, (int)Math.Floor((x + r - Min) / Cell));
        int j0 = Math.Max(0, (int)Math.Floor((z - r - Min) / Cell)), j1 = Math.Min(Size - 1, (int)Math.Floor((z + r - Min) / Cell));
        for (var j = j0; j <= j1; j++)
        {
            var dz = Min + (j + 0.5) * Cell - z;
            for (var i = i0; i <= i1; i++)
            {
                var dx = Min + (i + 0.5) * Cell - x;
                if (dx * dx + dz * dz > r * r)
                    continue;
                var index = j * Size + i;
                if (Has(index))
                    continue;
                _bits[index >> 3] |= (byte)(1 << (index & 7));
                into.Add(index);
            }
        }
        return into;
    }
}
