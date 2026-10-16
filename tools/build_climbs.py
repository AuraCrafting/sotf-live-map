"""Read the climbing ropes and ladders from the game's scene files and write web/data/climbs.js.

    python -I build_climbs.py "<game>/SonsOfTheForest_Data" ../web/data/underground.js ../web/data/climbs.js

Ropes are the game's ClimbingRopeRock objects (the rock a climbing rope hangs from, in caves and on the
island's cliffs); ladders are HatchLadder (the ladder down from a bunker's hatch). Each one is in the cave or
bunker whose outline (underground.js) is within 3 m of it, or on the island. Its height is the top of the
climb. A rope on the island that the map already has as a location (Climbing Rope) is left out.
"""
import json
import math
import os
import re
import subprocess
import sys
import tempfile

KINDS = {'ClimbingRopeRock': 'rope', 'HatchLadder': 'ladder'}
NAME = re.compile(r'^(ClimbingRopeRock|HatchLadder)( \(\d+\))?$')


def load_js(path, name):
    text = open(path, encoding='utf-8').read()
    return json.loads(re.search(r'window\.' + name + r'\s*=\s*(\[.*\]);?', text, re.S).group(1))


def main():
    data_dir, underground_path, out_path = sys.argv[1:4]
    here = os.path.dirname(os.path.abspath(__file__))
    with tempfile.TemporaryDirectory() as tmp:
        names = os.path.join(tmp, 'names.json')
        found = os.path.join(tmp, 'objects.json')
        json.dump(['re:' + NAME.pattern], open(names, 'w', encoding='utf-8'))
        subprocess.run([sys.executable, '-I', os.path.join(here, 'unity_scene.py'), data_dir, names, found], check=True)
        objects = json.load(open(found, encoding='utf-8'))
    areas = load_js(underground_path, 'SOTF_UNDERGROUND')
    locations = load_js(re.sub(r'underground\.js$', 'locations.js', underground_path), 'SOTF_LOCATIONS')
    listed = [l for l in locations if l['t'] == 'Climbing Rope']

    climbs = []
    for o in objects:
        m = NAME.match(o['name'])
        if not m:
            continue
        x, z, h = o['x'], o['z'], o['y']
        area = None
        for a in areas:
            if any(math.hypot(cx - x, cz - z) <= 3 for cx, cz, _ in a['cells']):
                area = a['id']
                break
        if area is None and any(math.hypot(l['x'] - x, l['y'] - z) <= 10 for l in listed):
            continue
        c = {'k': KINDS[m.group(1)], 'x': round(x, 2), 'y': round(z, 2), 'h': round(h, 1)}
        if area:
            c['a'] = area
        if not any(abs(d['x'] - c['x']) < 1 and abs(d['y'] - c['y']) < 1 and d['k'] == c['k'] for d in climbs):
            climbs.append(c)
    climbs.sort(key=lambda c: (c.get('a', ''), c['k'], c['x'], c['y']))
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('// Climbing ropes and ladders (k: rope or ladder; x, y: map position; h: the top of the climb; a: the\n'
                '// cave or bunker, none on the island) read from the game\'s scene files by tools/build_climbs.py.\n'
                '// Do not edit by hand.\n')
        f.write('window.SOTF_CLIMBS = ' + json.dumps(climbs) + ';\n')
    print(len(climbs), 'climbs:', sum(1 for c in climbs if c.get('a')), 'underground,',
          sum(1 for c in climbs if not c.get('a')), 'on the island', file=sys.stderr)


if __name__ == '__main__':
    main()
