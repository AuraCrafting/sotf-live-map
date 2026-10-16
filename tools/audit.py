"""Audit map locations against object positions read from the game's scene files.

python -I audit.py <upstream locations.json> <all_objects.json> <out report.json>
"""
import collections
import json
import math
import re
import sys

AREAS = {
    'level15': ('cave', 'Cave A'), 'level16': ('cave', 'Cave B'), 'level17': ('cave', 'Cave C'),
    'level18': ('cave', 'Cave D'), 'level19': ('cave', 'Ice caves'), 'level30': ('cave', 'Cave F'),
    'level31': ('cave', 'Cave G'), 'level38': ('cave', 'Cave H'),
    'level20': ('bunker', 'Maintenance bunker A'), 'level21': ('bunker', 'Maintenance bunker B'),
    'level22': ('bunker', 'Maintenance bunker C'), 'level23': ('bunker', 'Entertainment bunker'),
    'level24': ('bunker', 'Food and Dining bunker'), 'level25': ('bunker', 'Residential bunker'),
    'level26': ('bunker', 'Final bunker'),
}
NOISE = re.compile(r'^(_PickupGui_|ItemTemplatePickupGui|Collider|Colliders|Mesh|LOD\d|Root|Visual|Visuals|Model|Trigger|'
                   r'Interaction|Interact|Ui|UI|Gui|Light|Point Light|Spot Light|Decal|Audio|Sfx|SFX|Fx|FX|Bounds)$', re.I)


def base(name):
    n = re.sub(r'\s*\(\d+\)$', '', name)
    n = re.sub(r'\(Clone\)$', '', n, flags=re.I)
    return n.strip()


def main():
    up = json.load(open(sys.argv[1], encoding='utf-8'))
    objs = json.load(open(sys.argv[2], encoding='utf-8'))
    grid = collections.defaultdict(list)
    for o in objs:
        o['b'] = base(o['name'])
        if NOISE.match(o['b']):
            continue
        grid[(int(o['x'] // 10), int(o['z'] // 10))].append(o)

    def near(x, z, r):
        out = []
        for gx in range(int((x - r) // 10), int((x + r) // 10) + 1):
            for gz in range(int((z - r) // 10), int((z + r) // 10) + 1):
                for o in grid.get((gx, gz), ()):
                    d = math.hypot(o['x'] - x, o['z'] - z)
                    if d <= r:
                        out.append((d, o))
        return sorted(out, key=lambda t: t[0])

    by_type = collections.defaultdict(list)
    for e in up:
        by_type[e['type']].append(e)

    # Signature object names per type: names found within 2.5 m of at least half of the type's entries.
    signatures = {}
    for t, es in by_type.items():
        cnt = collections.Counter()
        for e in es:
            cnt.update({o['b'] for _, o in near(e['x'], e['y'], 2.5)})
        need = max(1, math.ceil(len(es) * 0.5)) if len(es) > 1 else 1
        sig = [n for n, c in cnt.most_common() if c >= need]
        tpn = {e['tp'].split(' ', 1)[1].strip() for e in es if e.get('tp') and not re.search(r'goto\s+-?\d', e['tp'])}
        tpn = {base(n) for n in tpn}
        if len(es) == 1:
            # a single entry can't vote; trust its teleport name if any, else the nearest pickup-ish object
            sig = sorted(tpn) or [o['b'] for _, o in near(es[0]['x'], es[0]['y'], 1.0) if 'Pickup' in o['b']][:1]
        signatures[t] = sig[:4]

    report = []
    for e in up:
        sig = set(signatures.get(e['type']) or [])
        tpname = e['tp'].split(' ', 1)[1].strip() if e.get('tp') and not re.search(r'goto\s+-?\d', e['tp']) else None
        if tpname:
            sig.add(base(tpname))
        hits = [(d, o) for d, o in near(e['x'], e['y'], 4.0) if o['b'] in sig]
        row = {'id': e['id'], 'type': e['type'], 'title': e['title'], 'x': e['x'], 'z': e['y'], 'sig': sorted(sig),
               'flags': [k for k in ('inCave', 'inBunker', 'isUnderground') if e.get(k)]}
        if hits:
            d, o = hits[0]
            row.update(status='ok', dist=round(d, 2), obj=o['name'], level=o['level'], h=o['y'])
        elif sig:
            cands = [o for o in objs if o['b'] in sig]
            row.update(status='mismatch', candidates=[{'name': o['name'], 'x': o['x'], 'z': o['z'], 'h': o['y'], 'level': o['level']}
                                                      for o in cands][:12])
        else:
            row.update(status='unchecked')
        area = AREAS.get(row.get('level'))
        row['area'] = area
        report.append(row)

    json.dump({'signatures': signatures, 'rows': report}, open(sys.argv[3], 'w', encoding='utf-8'), indent=1)
    c = collections.Counter(r['status'] for r in report)
    print('status:', dict(c))


if __name__ == '__main__':
    main()
