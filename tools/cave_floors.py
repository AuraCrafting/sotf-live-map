"""Cave plans from the caves' real floors: replaces those caves' outlines in web/data/underground.js.

    python -I cave_floors.py "<game>/SonsOfTheForest_Data" ../web/data/underground.js

build_data.py draws each cave and bunker from where the game's objects stand in its scene, so a passage with
nothing in it (an underwater tunnel, a long bare corridor) is missing and tunnels come out in pieces. Each
cave's own asset bundle (StreamingAssets/aa/.../caves_assets_<cave>_*.bundle) has the cave's collision split
into floor, ceiling, walls and rocks; this takes the floor meshes and turns them into the same 2 m cells
(x, z, height; a spot with two floors over each other gets a cell for each).

The map keeps which cells of a cave you've explored as one bit per cell, so new cells would lose that. The
outlines this replaces are kept in underground-v1.js, and the map app carries what you explored over to the
new cells once (see MapServer.Under). Run build_data.py first, then this.
"""
import collections
import glob
import json
import math
import os
import re
import statistics
import struct
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves this folder out
import unity_bundle  # noqa: E402
import unity_mesh  # noqa: E402

BUNDLES = {'cavea': 'cave-a', 'caveb': 'cave-b', 'cavec': 'cave-c', 'caved': 'cave-d', 'cavef': 'cave-f', 'caveg': 'cave-g'}
CELL = 2.0
LEVEL_GAP = 2.5  # metres between two floors over the same spot (less is one floor, with bumps or a slope)
VERSION = 2      # of these outlines (1: from objects, by build_data.py)


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw*bx + ax*bw + ay*bz - az*by, aw*by - ax*bz + ay*bw + az*bx, aw*bz + ax*by - ay*bx + az*bw, aw*bw - ax*bx - ay*by - az*bz)


def qrot(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    tx, ty, tz = 2 * (y*vz - z*vy), 2 * (z*vx - x*vz), 2 * (x*vy - y*vx)
    return (vx + w*tx + (y*tz - z*ty), vy + w*ty + (z*tx - x*tz), vz + w*tz + (x*ty - y*tx))


def floor_triangles(cab):
    """World-space triangles of the CaveCollisionFloor* meshes of an unpacked cave bundle."""
    a = unity_mesh.Asset(cab)
    d, E = a.d, a.E
    names, trs = {}, {}
    for pid, (off, size, c) in a.objs.items():
        if c == 1:  # GameObject: components, layer, name
            (n,) = struct.unpack_from(E + 'i', d, off)
            names[pid], _ = a.string(off + 4 + 12 * n + 4)
        elif c == 4:  # Transform: game object, rotation, position, scale, children, parent
            go = struct.unpack_from(E + 'iq', d, off)[1]
            q = struct.unpack_from(E + '4f', d, off + 12)
            p = struct.unpack_from(E + '3f', d, off + 28)
            s = struct.unpack_from(E + '3f', d, off + 40)
            (nc,) = struct.unpack_from(E + 'i', d, off + 52)
            trs[pid] = (go, q, p, s, struct.unpack_from(E + 'iq', d, off + 56 + 12 * nc)[1])
    cache = {}

    def world(t):
        if t not in cache:
            go, q, p, s, father = trs[t]
            if father in trs:
                pp, pq, ps = world(father)
                r = qrot(pq, (p[0]*ps[0], p[1]*ps[1], p[2]*ps[2]))
                cache[t] = ((pp[0]+r[0], pp[1]+r[1], pp[2]+r[2]), qmul(pq, q), (s[0]*ps[0], s[1]*ps[1], s[2]*ps[2]))
            else:
                cache[t] = (p, q, s)
        return cache[t]
    tr_of = {go: t for t, (go, *_rest) in trs.items()}
    tris = []
    for pid, (off, size, c) in a.objs.items():
        if c != 64:  # MeshCollider: its mesh is the last PPtr
            continue
        go = struct.unpack_from(E + 'iq', d, off)[1]
        fid, mesh = struct.unpack_from(E + 'iq', d, off + size - 12)
        if fid != 0 or not names.get(go, '').startswith('CaveCollisionFloor'):
            continue
        _, verts, tl = a.mesh(mesh)
        p, q, s = world(tr_of[go])
        wv = [tuple(pi + ri for pi, ri in zip(p, qrot(q, (v[0]*s[0], v[1]*s[1], v[2]*s[2])))) for v in verts]
        tris += [(wv[i], wv[j], wv[k]) for i, j, k in tl]
    return tris


def cells(tris):
    """[[x, z, height], ...]: every 2 m cell middle a floor triangle covers (and each triangle's own middle),
    one entry per floor over that spot."""
    hs = collections.defaultdict(list)
    for a, b, c in tris:
        ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
        nx, ny, nz = uy*vz - uz*vy, uz*vx - ux*vz, ux*vy - uy*vx
        length = math.sqrt(nx*nx + ny*ny + nz*nz)
        if not length or abs(ny) / length <= 0.35:  # steeper than about 70 degrees: a wall, not floor
            continue
        det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
        if not det:
            continue
        pts = [((a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3)]
        for i in range(math.floor(min(a[0], b[0], c[0]) / CELL), math.ceil(max(a[0], b[0], c[0]) / CELL) + 1):
            for k in range(math.floor(min(a[2], b[2], c[2]) / CELL), math.ceil(max(a[2], b[2], c[2]) / CELL) + 1):
                pts.append((i * CELL, k * CELL))
        for px, pz in pts:
            l1 = ((b[2] - c[2]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[2])) / det
            l2 = ((c[2] - a[2]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[2])) / det
            l3 = 1 - l1 - l2
            if min(l1, l2, l3) >= -1e-6:
                hs[(round(px / CELL), round(pz / CELL))].append(l1 * a[1] + l2 * b[1] + l3 * c[1])
    out = []
    for (i, k), heights in sorted(hs.items()):
        heights.sort()
        levels = [[heights[0]]]
        for h in heights[1:]:
            if h - levels[-1][-1] < LEVEL_GAP:
                levels[-1].append(h)
            else:
                levels.append([h])
        out += [[i * CELL, k * CELL, round(statistics.median(lv), 1)] for lv in levels]
    return out


def load_js(path, name):
    if not os.path.exists(path):
        return None
    text = open(path, encoding='utf-8').read()
    m = re.search(r'window\.' + name + r' = (.*?);\s*$', text, re.M | re.S)
    return json.loads(m.group(1)) if m else None


def main():
    data_dir, ug_path = sys.argv[1:3]
    v1_path = os.path.join(os.path.dirname(ug_path), 'underground-v1.js')
    areas = load_js(ug_path, 'SOTF_UNDERGROUND')
    old = load_js(v1_path, 'SOTF_UNDERGROUND_V1') or {}
    by_id = {a['id']: a for a in areas}
    bundles = os.path.join(data_dir, 'StreamingAssets', 'aa', 'StandaloneWindows64')
    for path in sorted(glob.glob(os.path.join(bundles, 'caves_assets_*.bundle'))):
        tag = re.search(r'caves_assets_([a-z]+)_', os.path.basename(path)).group(1)
        area = by_id.get(BUNDLES.get(tag))
        if area is None:
            print(tag, 'skipped (no cave of the map for it)', file=sys.stderr)
            continue
        with tempfile.TemporaryDirectory() as tmp:
            names = unity_bundle.unpack(path, tmp)
            tris = floor_triangles(os.path.join(tmp, next(n for n in names if not n.endswith('.resS'))))
        new = cells(tris)
        if area.get('v', 1) == 1:  # the outline from objects, kept to carry explored cells over
            old[area['id']] = area['cells']
        xs, zs, ys = [c[0] for c in new], [c[1] for c in new], [c[2] for c in new]
        area.update({'v': VERSION, 'bounds': [min(xs), min(zs), max(xs), max(zs)], 'y': [min(ys), max(ys)], 'cells': new})
        print(f"{area['id']}: {len(new)} cells from {len(tris)} floor triangles", file=sys.stderr)
    with open(ug_path, 'w', encoding='utf-8') as f:
        f.write("// Cave and bunker outlines (2 m cells: x, z, height) read from the game's files by tools/build_data.py\n")
        f.write('// (from objects) and tools/cave_floors.py (caves, from their floor meshes: "v": 2).\n')
        f.write('window.SOTF_UNDERGROUND = ' + json.dumps(areas, separators=(',', ':')) + ';\n')
    with open(v1_path, 'w', encoding='utf-8') as f:
        f.write('// The outlines tools/cave_floors.py replaced, by cave: for the map app to carry explored cells over.\n')
        f.write('window.SOTF_UNDERGROUND_V1 = ' + json.dumps(old, separators=(',', ':')) + ';\n')


if __name__ == '__main__':
    main()
