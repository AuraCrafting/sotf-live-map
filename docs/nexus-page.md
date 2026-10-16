# Nexus Mods page (draft)

Text for the SOTF Live Map page on Nexus Mods. Nexus descriptions use BBCode, so the long description is below
as BBCode, ready to paste.

## Fields

- **Mod name:** SOTF Live Map
- **Category:** Miscellaneous (Sons of the Forest has Gameplay, Miscellaneous and Visuals)
- **Version:** the release version, e.g. 3.3.0 (the same zip as the GitHub release)
- **Author:** AuraCrafting
- **Language:** English
- **Adult content:** no
- **Summary** (the short text under the title, max. 350 characters):

  > A live map of the island on your second screen or phone: you, Kelvin and Virginia, co-op friends, GPS
  > markers and caves. Explore mode is spoiler-free: fog over where you haven't been, and only what you've
  > found. Read-only MelonLoader mod, no cheats, no Overwolf.

- **Requirements** (Nexus "Requirements" tab, off-site links):
  - MelonLoader 0.7.x: https://github.com/LavaGang/MelonLoader (the installer gets 0.7.3 if you don't have it)
  - .NET 6 Runtime (x64): https://dotnet.microsoft.com/download/dotnet/6.0 (the installer offers to install it)
- **Permissions:** source code MIT (link the GitHub repo). Map tiles, icons, screenshots and the original
  location data are from Leon Machens' Sons of the Forest map, also MIT; credit it when reusing them.
- **Main file:** `SOTF-Live-Map-<version>.zip`. File description: "Unzip anywhere, run Install.bat."

## Description (BBCode)

```bbcode
[size=5][b]SOTF Live Map[/b][/size]
[i]Live position, waypoints and progress tracking for Sons of the Forest, on your second screen or your phone. No Overwolf.[/i]

[size=4][b]Why I made this[/b][/size]
When I got stuck, I'd look up a video to find one thing, and every video showed me more than I wanted to know. I didn't want to spoil the island for myself, but I also didn't want to wander around for hours looking for one item.

So I made the map I was missing. It only shows what [i]you[/i] have found and where [i]you[/i] have been, with fog over the rest. It tells you what a locked door needs, not where to find it. When you're really stuck, you ask for one location with the red [b]Show location (spoiler)[/b] button, and you get that one, nothing else. And if you'd rather see everything, switch to [i]Guide[/i].

[size=4][b]What it does[/b][/size]
[list]
[*][b]Two modes.[/b] [i]Explore[/i] (the default) is spoiler-free: it shows where you've been, what you've found and the locked doors you've come across, with what they need. [i]Guide[/i] shows every location.
[*][b]Fog over what you haven't explored.[/b] In Explore, mist covers the island except where you've been. It fills in from your saves on the first start, you choose how thick it is, and caves and bunkers have fog of their own.
[*][b]Live position.[/b] You, with the direction you're facing, twice a second. "Follow me" keeps you in the middle.
[*][b]Kelvin, Virginia and co-op friends[/b], live, with their names.
[*][b]Your GPS markers[/b], as the in-game GPS shows them.
[*][b]Cave and bunker view.[/b] Underground, the map switches to the cave you're in, drawn as a plan from the game's own files: each floor in its own colour, walls, a 10 m grid and a scale bar.
[*][b]About 1000 checked locations.[/b] Items, places and collectibles, with positions checked against the game files and the ways into every cave and bunker.
[*][b]Your progress from your saves.[/b] What you carry, the places the game marks as found, your zip lines, camps and parked vehicles.
[*][b]Guide me here.[/b] Pick anything on the map (on your PC or phone) and an arrow at the top of the game screen points the way. F8 hides it. It's an overlay; the game's GPS isn't touched.
[*][b]Pins, trail, every world separately,[/b] dark mode, search and a phone layout. Your PC and phone stay in sync.
[/list]

[size=4][b]Requirements[/b][/size]
[list]
[*]Sons of the Forest on Steam (Windows)
[*][url=https://github.com/LavaGang/MelonLoader]MelonLoader[/url] 0.7.x. The installer downloads 0.7.3 for you (checked against its published checksum) if you don't have it.
[*].NET 6 Runtime. The installer checks for it and offers to install it.
[/list]

[size=4][b]Install[/b][/size]
[list=1]
[*]Download the zip and unzip it anywhere.
[*]Double-click [b]Install.bat[/b]. It finds the game through Steam (or asks for the folder), installs MelonLoader if needed, and puts the mod in [i]Mods\SOTFLiveMap.dll[/i] and the map in [i]<game>\SOTFLiveMap\[/i]. It also adds a desktop shortcut.
[*]Start the game as you normally do. The map opens in your browser by itself. The first start with MelonLoader takes a few extra minutes.
[/list]
[b]Phone:[/b] same Wi-Fi as your PC, open the map menu, tap [i]Open on phone[/i] and scan the code. Allow [i]SOTF Live Map.exe[/i] when Windows Firewall asks.
[b]Vortex / mod managers:[/b] not supported. Use Install.bat.
[b]"Windows protected your PC":[/b] the files aren't code-signed. Click [i]More info[/i], then [i]Run anyway[/i].

[size=4][b]Updating[/b][/size]
The map tells you when there's a new version (at the top of its menu). Press [b]Update[/b]: it downloads the release from GitHub, checks its SHA-256 and installs it once the game is closed, then starts again. Nothing installs without you pressing Update. Or download the new zip here and run Install.bat. Either way your progress and settings are kept.

[size=4][b]Uninstall[/b][/size]
Double-click [b]Uninstall.bat[/b]. It removes the mod and the map, and MelonLoader too if no other mods use it. Your progress is kept unless you choose to delete it. The game's own files are never changed.

[size=4][b]Achievements and safety[/b][/size]
[list]
[*][b]Achievements are not affected, as far as we know.[/b] The mod changes nothing in the game: no Harmony patches, no console commands or cheats, no game settings, nothing written to your saves, nothing sent over the co-op network. It only reads positions and draws the guide arrow as an overlay. We can't prove it from outside the game, so if you want to be sure, earn an achievement you don't have yet with the mod loaded and check that it unlocks.
[*][b]No cheat switch.[/b] It uses MelonLoader on purpose. RedLoader switches on the game's console-cheat flag; if the installer finds RedLoader, it moves it to a backup folder (it asks first).
[*][b]Local.[/b] Your progress and position stay on your PC and home network. The map makes one request of its own to the internet: an update check with GitHub at start and every 6 hours, which sends nothing about you or your game. Switch it off in the map menu ([i]Check for updates[/i]) or with [i]CheckForUpdates = false[/i] under [i][LiveMap][/i] in [i]UserData\MelonPreferences.cfg[/i].
[*][b]Open source:[/b] [url=https://github.com/AuraCrafting/sotf-live-map]github.com/AuraCrafting/sotf-live-map[/url] (MIT).
[/list]

[size=4][b]Problems?[/b][/size]
Check [i]MelonLoader\Latest.log[/i] for "SOTF Live Map". If the mod isn't listed, run Install.bat again. Report bugs in the Bugs tab here or on [url=https://github.com/AuraCrafting/sotf-live-map/issues]GitHub[/url], with that log.

[size=4][b]Credits[/b][/size]
[list]
[*]Map tiles, icons, screenshots and the original location data: the open-source [url=https://github.com/lmachens/sons-of-the-forest-map]Sons of the Forest map[/url] by Leon Machens (MIT).
[*][url=https://leafletjs.com]Leaflet[/url] (BSD-2-Clause) and [url=https://github.com/davidshimjs/qrcodejs]QRCode.js[/url] (MIT).
[*][url=https://github.com/LavaGang/MelonLoader]MelonLoader[/url] by LavaGang (Apache-2.0), downloaded by the installer, not bundled.
[/list]
This is a fan project, not affiliated with or endorsed by Endnight Games. Sons of the Forest and its assets belong to Endnight Games.
```

## Before posting

- Upload the same zip as the GitHub release, so the SHA-256 in the release notes matches both.
- Check Nexus Mods' current rules for mods that download their own updates (the map's Update button gets
  the zip from GitHub, only when the player presses it). Say so on the page, as above.
- Screenshots for the gallery: the map in Explore with the fog, the cave view, the phone layout, the guide arrow
  in game. Take them from your own game (don't reuse the ones in `web/screenshots`, those are item photos).
- After the first upload, set the GitHub variables NEXUSMODS_FILE_ID and NEXUSMODS_MOD_ID (see
  `.github/workflows/nexus.yml`): from then on every GitHub release is uploaded here by itself.
