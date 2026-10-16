"""Check the map data against the game's scene files and write web/data/locations.js + underground.js.

Steps (run from this folder, Python 3, standard library only):
  1. python -I unity_scene.py "<game>/SonsOfTheForest_Data" all.json objects.json      (all.json = ["re:."])
  2. python -I audit.py upstream_locations.json objects.json audit.json
  3. python -I build_data.py ../web/data/locations.js objects.json audit.json
  4. python -I cave_floors.py "<game>/SonsOfTheForest_Data" ../web/data/underground.js
     (the caves' real floors from their asset bundles, in place of the outlines step 3 makes for them)

Step 3 fixes positions that the game contradicts, sets "In a cave"/"In a bunker" from where the item
really is, drops the teleport-command tips, marks entries that couldn't be found in the game files,
and writes the cave/bunker outlines used by the map's cave view.
"""
import collections
import os
import json
import math
import re
import statistics
import sys

AREAS = {
    'level15': ('cave-a', 'Cave A', 'cave'), 'level16': ('cave-b', 'Cave B', 'cave'),
    'level17': ('cave-c', 'Cave C', 'cave'), 'level18': ('cave-d', 'Cave D', 'cave'),
    'level19': ('ice-caves', 'Ice caves', 'cave'), 'level30': ('cave-f', 'Cave F', 'cave'),
    'level31': ('cave-g', 'Cave G', 'cave'), 'level38': ('cave-h', 'Cave H', 'cave'),
    'level20': ('maint-a', 'Maintenance bunker A', 'bunker'), 'level21': ('maint-b', 'Maintenance bunker B', 'bunker'),
    'level22': ('maint-c', 'Maintenance bunker C', 'bunker'), 'level23': ('entertainment', 'Entertainment bunker', 'bunker'),
    'level24': ('food', 'Food and Dining bunker', 'bunker'), 'level25': ('residential', 'Residential bunker', 'bunker'),
    'level26': ('final', 'Final bunker', 'bunker'),
}
CELL = 2.0
# Positions the game contradicts, with the object that proves where the item really is.
MOVES = {20: 'CrossbowPickup'}
# Entries with no matching object anywhere near; they may be spawned at runtime, so they stay but get a note.
UNCONFIRMED = {825, 84, 92, 3333, 883}
ENTRANCE_CATS = {'cave', 'bunker'}
# Broad places are matched on generic objects, so their area can't be trusted: keep the source's tags.
PLACE_CATS = {'village', 'camp', 'poi', 'spawn', 'grave', 'gps'}


def load_js(path):
    text = open(path, encoding='utf-8').read()
    def grab(name):
        m = re.search(r'window\.%s\s*=\s*(\[.*?\]);\s*$' % name, text, re.S | re.M)
        return json.loads(m.group(1))
    return grab('SOTF_CATEGORIES'), grab('SOTF_LOCATIONS')


def main():
    loc_path, objects_path, audit_path = sys.argv[1:4]
    cats, locs = load_js(loc_path)
    objs = json.load(open(objects_path, encoding='utf-8'))
    audit = {r['id']: r for r in json.load(open(audit_path, encoding='utf-8'))['rows']}

    # ---- cave / bunker outlines on a 2 m grid ----
    per_area = collections.defaultdict(list)
    for o in objs:
        a = AREAS.get(o['level'])
        if a and not (o['x'] == 0 and o['z'] == 0):
            per_area[a[0]].append(o)
    areas, cells_by_area = [], {}
    for lvl, (aid, name, kind) in AREAS.items():
        ps = per_area.get(aid, [])
        if not ps:
            continue
        qx = statistics.quantiles([o['x'] for o in ps], n=50)
        qz = statistics.quantiles([o['z'] for o in ps], n=50)
        lo_x, hi_x, lo_z, hi_z = qx[0] - 60, qx[-1] + 60, qz[0] - 60, qz[-1] + 60
        cells = collections.defaultdict(list)
        for o in ps:
            if lo_x <= o['x'] <= hi_x and lo_z <= o['z'] <= hi_z:
                cells[(round(o['x'] / CELL), round(o['z'] / CELL))].append(o['y'])
        cells_by_area[aid] = {k: (min(v), max(v)) for k, v in cells.items()}
        pts = [[k[0] * CELL, k[1] * CELL, round(statistics.median(v), 1)] for k, v in sorted(cells.items())]
        xs, zs, ys = [p[0] for p in pts], [p[1] for p in pts], [p[2] for p in pts]
        areas.append({'id': aid, 'name': name, 'kind': kind, 'cell': CELL,
                      'bounds': [min(xs), min(zs), max(xs), max(zs)], 'y': [min(ys), max(ys)], 'cells': pts})

    def area_at(x, z, h=None, reach=10.0, need=6):
        best, score = None, 0
        r = int(reach / CELL)
        cx, cz = round(x / CELL), round(z / CELL)
        for aid, cells in cells_by_area.items():
            n = 0
            for dx in range(-r, r + 1):
                for dz in range(-r, r + 1):
                    c = cells.get((cx + dx, cz + dz))
                    if c and (h is None or c[0] - 6 <= h <= c[1] + 6):
                        n += 1
            if n > score:
                best, score = aid, n
        return best if score >= need else None

    area_info = {a['id']: a for a in areas}
    obj_by_name = collections.defaultdict(list)
    for o in objs:
        obj_by_name[o['name']].append(o)

    changes = collections.Counter()
    for l in locs:
        r = audit.get(l['id'], {})
        if l.pop('w', None):
            changes['teleport tip removed'] += 1
        if l['id'] in MOVES:
            o = obj_by_name[MOVES[l['id']]][0]
            l['x'], l['y'] = round(o['x'], 2), round(o['z'], 2)
            r = dict(r, status='ok', level=o['level'], h=o['y'])
            changes['position fixed'] += 1
        h = r.get('h') if r.get('status') == 'ok' else None
        old = set(l.get('g', []))
        aid = None
        if r.get('status') == 'ok':
            a = AREAS.get(r.get('level'))
            aid = a[0] if a else area_at(l['x'], l['y'], h)
        elif old & {'In a cave', 'In a bunker'} or l['c'] in ENTRANCE_CATS:
            aid = area_at(l['x'], l['y'], None, reach=24, need=3)
        if l['c'] in PLACE_CATS and not old & {'In a cave', 'In a bunker'}:
            aid = None
        if l['c'] in ENTRANCE_CATS:
            if aid:
                l['a'] = aid  # entrance belongs to this cave/bunker; its own tags stay as they were
            continue
        if aid:
            a = area_info[aid]
            area_names = {x['name'] for x in areas}
            rest = [t for t in l.get('g', []) if t not in ('In a cave', 'In a bunker') and t not in area_names]  # safe to re-run
            tags = ['In a cave' if a['kind'] == 'cave' else 'In a bunker', a['name']] + rest
            l['a'] = aid
        else:
            tags = list(l.get('g', []))  # no positive evidence (e.g. small grottos in the main world): keep the source's tags
        if set(tags) != old:
            changes['location tag corrected'] += 1
        if tags:
            l['g'] = tags
        else:
            l.pop('g', None)
        if l['id'] in UNCONFIRMED:
            l['u'] = 1
            changes['marked unconfirmed'] += 1
        if l['id'] == 20:
            l['d'] = 'In the Food and Dining bunker (Maintenance Keycard needed)'

    # Vehicles: tag each pin with the game's id (World.GolfCart.07 etc.) so the map can move it to
    # where you parked it (read from your save). Teleport names give carts and gliders; Knight Vs are
    # matched to the nearest spawn object, because their titles are numbered differently from the game.
    here = os.path.dirname(os.path.abspath(__file__))
    tp_by_id = {e['id']: e.get('tp') or '' for e in json.load(open(os.path.join(here, 'upstream_locations.json'), encoding='utf-8'))}
    spawns = {}
    for o in objs:
        m = re.fullmatch(r'World(GolfCart|HangGlider|KnightV)(\d+)', o['name'])
        if m:
            spawns[f'World.{m.group(1)}.{m.group(2)}'] = o
    for l in locs:
        if l['c'] != 'vehicle':
            continue
        m = re.fullmatch(r'goto World(GolfCart|HangGlider|KnightV)(\d+)', tp_by_id.get(l['id'], ''))
        vid = f'World.{m.group(1)}.{m.group(2)}' if m else None
        if not vid:
            kind = 'KnightV' if l['i'] == 'knightv' else 'GolfCart' if l['i'] == 'golf-cart' else 'HangGlider' if l['i'] == 'hang-glider' else None
            near = sorted((math.hypot(o['x'] - l['x'], o['z'] - l['y']), k) for k, o in spawns.items() if kind and f'.{kind}.' in k)
            vid = near[0][1] if near and near[0][0] < 15 else None
        if vid in spawns:
            l['v'] = vid
            o = spawns[vid]
            if math.hypot(o['x'] - l['x'], o['z'] - l['y']) > 5:
                l['x'], l['y'] = round(o['x'], 2), round(o['z'], 2)
                changes['vehicle spawn fixed'] += 1
            changes['vehicle linked to game id'] += 1

    header = ('// Generated from github.com/lmachens/sons-of-the-forest-map (MIT), checked against the game\'s\n'
              '// scene files by tools/build_data.py. Do not edit by hand.\n')
    with open(loc_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(header)
        f.write('window.SOTF_CATEGORIES = ' + json.dumps(cats, ensure_ascii=False) + ';\n')
        f.write('window.SOTF_LOCATIONS = ' + json.dumps(locs, ensure_ascii=False, separators=(',', ':')) + ';\n')
    ug_path = re.sub(r'locations\.js$', 'underground.js', loc_path)
    with open(ug_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('// Cave and bunker outlines (2 m cells: x, z, height) read from the game\'s scene files by tools/build_data.py.\n')
        f.write('window.SOTF_UNDERGROUND = ' + json.dumps(areas, separators=(',', ':')) + ';\n')
    print(dict(changes))
    print({a['id']: len(a['cells']) for a in areas})
    print('items per area:', dict(collections.Counter(l.get('a') for l in locs if l.get('a'))))


if __name__ == '__main__':
    main()
