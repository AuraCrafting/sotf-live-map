namespace LiveMap;

/// <summary>Carries files over from earlier versions of the map.</summary>
public static class Upgrade
{
    /// <summary>The folder earlier versions used, when the map was still called SOTF Field Map.</summary>
    public const string OldFolderName = "SOTF Field Map";

    /// <summary>
    /// Moves everything from the old progress folder to the new one, on the first start after the upgrade.
    /// progress.json is taken over only when the new folder has no found markers or pins in any world yet;
    /// whatever it replaces is kept with a time stamp, and an old progress.json that isn't used is kept the
    /// same way. Other files never overwrite a file of the same name. Each copy is checked before the old
    /// folder is removed; if anything goes wrong the old folder stays as it is and the next start tries again.
    /// </summary>
    public static void MoveDataFolder(string oldDir, string newDir)
    {
        if (!Directory.Exists(oldDir) || Path.GetFullPath(oldDir).Equals(Path.GetFullPath(newDir), StringComparison.OrdinalIgnoreCase))
            return;
        try
        {
            Directory.CreateDirectory(newDir);
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            foreach (var file in Directory.GetFiles(oldDir))
            {
                var name = Path.GetFileName(file);
                if (name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase))
                    continue; // half of an interrupted save; the progress.json next to it is the real one
                var dest = Path.Combine(newDir, name);
                if (File.Exists(dest))
                {
                    if (name.Equals("progress.json", StringComparison.OrdinalIgnoreCase) && MapServer.FileHasProgress(file) && !MapServer.FileHasProgress(dest))
                        File.Copy(dest, Path.Combine(newDir, $"progress.replaced-{stamp}.json"), true); // the old one wins; keep the empty one
                    else
                        dest = Path.Combine(newDir, $"{Path.GetFileNameWithoutExtension(name)}.old-{stamp}{Path.GetExtension(name)}");
                }
                File.Copy(file, dest, true);
                if (!File.ReadAllBytes(file).AsSpan().SequenceEqual(File.ReadAllBytes(dest)))
                    throw new IOException($"the copy of {name} doesn't match");
            }
            Directory.Delete(oldDir, true);
            Console.WriteLine($"  Moved your progress from {oldDir} to {newDir}.");
        }
        catch (Exception e)
        {
            Console.WriteLine($"  Could not move your progress from {oldDir} ({e.Message}). It stays there and the map tries again next start.");
        }
    }
}
