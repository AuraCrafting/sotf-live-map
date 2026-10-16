# SOTF Live Map

**Live position, waypoints and progress tracking for Sons of the Forest.** A map on your second screen or
your phone, with no Overwolf. You see where you are while you play, and so do your companions and friends.
Underground, it switches to the cave or bunker you're in.

## Features

- **Two modes: Explore and Guide.** *Explore* (the default) is spoiler-free: the map shows where you've been,
  what you've found, and the locked doors you've come across, with a **To unlock** list of what they need
  (Maintenance Card ← needs Shovel). Where something is stays hidden until you ask for it with a red
  **Show location (spoiler)** button. *Guide* shows every location. Switch with the slider in the top bar
  (tap or slide it); going to Guide asks first, and coming back to Explore is one tap and changes nothing.
- **Fog over what you haven't explored.** In Explore, mist covers the island except where you've been:
  about 50 m around you as you play, where you saved, what you changed in the world, your camps and the
  places you found. It fills in from your saves (and an earlier version's trail) on the first start. The
  **Fog** button on the right turns it on or off (on in Explore, off in Guide until you turn it on); point at
  it (or turn it on, on a phone) to set how thick it is (it starts thin), see how much of the island you've
  explored, or put the fog back over everything (with Undo). Clearing your trail doesn't touch it. Caves and bunkers have fog of
  their own: in their view, the tunnels you haven't been through are misty or hidden, the banner says how
  much of that cave you've explored, and you can reset just that one. Walking over a cave doesn't count.
- **Your history from your saves.** Items you carry that have only one spot on the map, the places the
  game itself marks as found, and your zip lines count as found or visited, so the map knows where you've
  been from the first start. The trail keeps your height: walking over a bunker isn't being inside it.
  Every save also lists what you changed in the world (trees you felled, crates you opened, things you
  took): the map shades the ground around those spots as where you've been (switch it off in the trail
  menu) and marks places near them visited. Items are only marked when you carry them: walking past one
  isn't taking it. For an item you carry with several spots, the one with a change right at it counts as
  found; when several have one, or none does, the closest (or the one nearest to where you've been) is
  marked **Probably found here**, with one tap to confirm it or to say it wasn't there.
- **Live position.** You, with the direction you're facing, updated twice a second and gliding smoothly
  between updates. "Follow me" keeps you in the middle of the map.
- **Kelvin and Virginia.** Their live positions, with names.
- **Co-op friends.** Other players are shown the same way as you, in their own colour and with their name.
- **Your GPS markers.** Trackers you placed and tracker darts, as the in-game GPS shows them. The GPS's own
  markers are named by what they are (Cave, GPS locator, ...), and a cave your GPS shows counts as known.
- **Cave and bunker view.** When you go underground, the island goes dark and the map shows that cave's
  tunnels and only the items inside it. The outlines are read from the game's own files and drawn as a
  plan: each floor in its own colour, ramps and shafts in grey, walls, a 10 m grid, a scale bar and north.
  Chips in the banner show one floor at a time (the others, and their items, fade); underground, the
  floor you're on is picked for you.
- **Your camps.** Everything you've built, grouped by place, with a list of what's there.
- **Parked vehicles.** Golf carts, Knight Vs and hang gliders at the spot where you left them. In Explore
  the map shows only the ones you've moved or come close to; Guide shows all of them. A glider you fold up
  and put down somewhere else shows as **Your glider** where you left it (after you save), with Guide me
  here. Your save doesn't say which glider spot one you carry came from, so the map asks: open it and tap
  **It came from here**.
- **Checked locations.** About 1000 items, places and collectibles. Their positions and their
  "In a cave" / "In a bunker" labels were checked against the game files, and the "Ways in" on each
  underground item shows its entrances.
- **Your progress.** Mark things as found, drop your own pins, and see where you've been. Your PC and
  phone stay in sync. Click (or tap) the map to drop a pin: on a PC its type, **Place pin** and **Cancel**
  sit right next to it (Enter places it, Esc cancels); on a phone they're in a small bar at the bottom.
- **Your trail.** Show the last hour, today or everything, or reset it for one world (with Undo).
- **Every world separately.** Single player and co-op worlds each keep their own found markers, pins,
  trail, camps and vehicles. When you load another world, the map switches straight away, without you
  saving first. A picker lets you look at your other worlds.
- **Guide me here.** Pick any item, pin or camp on the map (on your PC or phone), and an arrow at the top of
  the game screen points the way, with the distance and direction ("Main base · 320 m · NE"). Press **F8**
  to hide or show it. It's an overlay only; the game's own GPS isn't touched.
- **Piles of markers fan out.** On a PC they spread when you hover over them; on a phone or tablet, the
  first tap spreads them and the second opens one.
- **Phone and tablet layouts.** On a phone, a tap opens a small card with **Guide me here** and **Mark as
  found** right under your thumb; swipe it up for the details. Also dark mode, search, filters, and offline
  use from the last save.
- **A short welcome.** The first time you open the map on a device, it asks how you want to play (Explore or
  Guide), dark or light, and how much fog, and shows where the controls are. Skip it at any step; **Show welcome again** in
  the side panel brings it back.

## Install

1. Download `SOTF-Live-Map-<version>.zip` from the Releases page and unzip it anywhere.
2. Double-click **Install.bat**. It:
   - finds the game through Steam (or lets you pick the folder),
   - installs [MelonLoader](https://github.com/LavaGang/MelonLoader) 0.7.3 if you don't have it, checking
     the download against its published checksum,
   - checks for the .NET 6 runtime that MelonLoader needs, and offers to install it,
   - installs the mod (`Mods\SOTFLiveMap.dll`) and the map (`<game>\SOTFLiveMap\`),
   - adds a **SOTF Live Map** shortcut to your desktop.
3. Start the game as you normally do. The map opens in your browser by itself.
   - The very first start with MelonLoader takes a few extra minutes, because it prepares the game files once.

**On your phone:** connect to the same Wi-Fi as your PC, open the map menu and tap **Open on phone**, then
scan the code. When Windows asks, allow `SOTF Live Map.exe`.

**Without the game:** use the desktop shortcut. You then see your last save, your camps and your vehicles.

**Updating:** when there's a new version, the map says so at the top of its menu, with what's new. Press
**Update**: the map downloads the release from GitHub, checks it against the SHA-256 the release publishes, and
installs it as soon as the game is closed (straight away if it isn't running), then starts again by itself.
Nothing is installed until you press Update. You can also download the new zip and run its Install.bat. Both
keep your progress and settings.

## Uninstall

Double-click **Uninstall.bat**. It removes the mod and the map, and MelonLoader too if no other mods use it.
Your progress is kept unless you choose to delete it. The game's own files are never modified.

## Is it safe? Achievements?

- **Read-only mod.** It only reads positions, and it draws the guide arrow as a screen overlay. There are no Harmony patches, no console commands or cheats,
  no changed game settings, nothing written to your saves and nothing sent over the co-op network.
- **No cheat switch.** It uses MelonLoader, a general-purpose loader. RedLoader is avoided on purpose,
  because it switches on the game's console-cheat flag.
- **Achievements are not affected as far as we know**, because nothing in the game is changed. If you want
  to be sure, earn an achievement you don't have yet with the mod loaded and check that it unlocks.
- **Local only.** Your progress, position and saves stay on your PC and home network: the map talks to
  `localhost` and your phone. It makes one request of its own to the internet: the update check, a GET of
  `https://api.github.com/repos/AuraCrafting/sotf-live-map/releases/latest` when it starts and every 6 hours. That
  sends nothing about you or your game (GitHub sees your IP address, as with any website). Switch it off
  with **Check for updates** at the bottom of the map menu, or `CheckForUpdates = false` under `[LiveMap]`.
  Other downloads: the release zip when you press **Update**, MelonLoader during install, and the files
  MelonLoader fetches on its first start.

## Troubleshooting

- **"Windows protected your PC" (SmartScreen):** the tools aren't code-signed. Click *More info* → *Run anyway*.
- **The phone can't load the map:** allow `SOTF Live Map.exe` in Windows Firewall (Windows Security →
  Firewall → Allow an app), and make sure the phone is on the same Wi-Fi.
- **The map stays on "Last save":** check `MelonLoader\Latest.log` for "SOTF Live Map". If the mod isn't
  listed, run Install.bat again.
- **Port 8765 is taken:** set `Port` under `[LiveMap]` in `<game>\UserData\MelonPreferences.cfg`, and
  start `"SOTF Live Map.exe" --port <same number>`.
- **Settings** (in `UserData\MelonPreferences.cfg`, section `[LiveMap]`):
  - `AutoStartMap`: start the map with the game.
  - `MapExe`: a different map program.
  - `Port`: the map's port.
  - `ShowGuide`: show the guide arrow.
  - `GuideKey`: the key that hides or shows it (default `F8`).
  - `CheckForUpdates`: let the map look for a new version on GitHub (default `true`; it never installs one
    by itself).

## Where things are

| What | Where |
|---|---|
| Mod | `<game>\Mods\SOTFLiveMap.dll` |
| Map app | `<game>\SOTFLiveMap\SOTF Live Map.exe` (serves `web\` on port 8765) |
| Your progress (found, pins, trail) | `%LOCALAPPDATA%\SOTF Live Map\progress.json` |
| Progress from the old Python map, if you had it | `<game>\SOTFLiveMap\import\progress.json` (the map imports it once, when you have no found markers or pins yet) |
| Save games it reads | `%USERPROFILE%\AppData\LocalLow\Endnight\SonsOfTheForest\Saves` |

## Building from source

The source is at https://github.com/AuraCrafting/sotf-live-map. You need the .NET SDK 6 or newer, and the game
with MelonLoader started once (the mod compiles against the assemblies MelonLoader generates).

```
powershell -ExecutionPolicy Bypass -File build\release.ps1
```

This writes `dist\SOTF-Live-Map-<version>.zip`. To check that upgrades keep everyone's progress, run
`powershell -ExecutionPolicy Bypass -File tools\test_upgrade.ps1` (the map app) and
`powershell -ExecutionPolicy Bypass -File tools\test_install.ps1` (the installer, from an earlier version).
`tools\test_update.ps1` checks the update check and the Update button against a fake GitHub. All three use
spare ports and made-up saves, never your own.

**Making a release** is one command:

```
powershell -ExecutionPolicy Bypass -File build\publish.ps1 -Version 3.3.0 [-Notes notes.md] [-Publish]
```

It sets the version (both projects and the mod's MelonInfo), runs the three tests and `build\release.ps1`,
writes the release notes and the zip's SHA-256 to `dist\`, then commits and tags `v3.3.0`. Only with
`-Publish` does it push and create the GitHub release (with the [GitHub CLI](https://cli.github.com)), on
the repo set as `UpdateRepo` in `src/LiveMap.App/LiveMap.App.csproj`. That is also the repo the map checks
for updates; while it's empty, the map never checks. Releases are built on your own PC, not on CI: the mod
compiles against the assemblies MelonLoader generates from the game.

The project is laid out like this:

- `src/LiveMap.Mod/`: the MelonLoader mod.
- `src/LiveMap.App/`: the map server (stdlib .NET, no dependencies).
- `web/`: the map itself (Leaflet).
- `installer/`: Install.bat, Uninstall.bat and install.ps1.
- `build/`: `release.ps1` (the zip) and `publish.ps1` (a whole release).
- `tools/`: the upgrade, install and update tests, and Python scripts that check the location data against the game's scene files
  and extract cave outlines and structure names (only needed when the game updates; see `tools/build_data.py`).

## Credits

- Map tiles, icons, screenshots and the original location data come from the open-source
  [Sons of the Forest map](https://github.com/lmachens/sons-of-the-forest-map) by Leon Machens (MIT).
- [Leaflet](https://leafletjs.com) (BSD-2-Clause), [QRCode.js](https://github.com/davidshimjs/qrcodejs) (MIT),
  and [MelonLoader](https://github.com/LavaGang/MelonLoader) (Apache-2.0; downloaded by the installer, not bundled).
- Fonts: [IBM Plex Mono](https://github.com/IBM/plex) by IBM, [Saira Condensed](https://github.com/Omnibus-Type/Saira)
  by The Saira Project Authors and [Source Sans 3](https://github.com/adobe-fonts/source-sans) by Adobe
  (all SIL Open Font License 1.1), bundled in `web/fonts`.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This is a fan project. It is not affiliated with or endorsed by Endnight Games. Sons of the Forest and its
assets belong to Endnight Games.
