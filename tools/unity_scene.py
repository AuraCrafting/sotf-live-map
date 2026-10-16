"""Minimal reader for Unity 2022 player scene files (SerializedFile v22, no type trees).

Reads GameObjects (class 1) and Transforms (class 4 / RectTransform 224) and computes world
positions by walking the parent chain. Usage:

    python -I unity_scene.py <SonsOfTheForest_Data dir> <names.json> <out.json>

names.json is a list of GameObject names (or "re:<regex>") to report.
"""
import json
import math
import os
import re
import struct
import sys


def read_cstr(d, o):
    e = d.index(b'\0', o)
    return d[o:e].decode('utf-8', 'replace'), e + 1


def parse(path):
    d = open(path, 'rb').read()
    version = struct.unpack_from('>I', d, 8)[0]
    if version < 22:
        raise ValueError(f'{path}: unsupported version {version}')
    big = d[16] != 0
    meta_size, file_size, data_offset = struct.unpack_from('>IQQ', d, 20)
    o = 48
    E = '>' if big else '<'
    unity_version, o = read_cstr(d, o)
    o += 4  # target platform
    type_tree = d[o] != 0
    o += 1
    if type_tree:
        raise ValueError(f'{path}: has type trees (not handled)')
    (ntypes,) = struct.unpack_from(E + 'i', d, o); o += 4
    class_ids = []
    for _ in range(ntypes):
        cid, stripped, script_idx = struct.unpack_from(E + 'i?h', d, o); o += 7
        if cid == 114 or script_idx >= 0:
            o += 16  # script id
        o += 16  # old type hash
        class_ids.append(cid)
    (nobj,) = struct.unpack_from(E + 'i', d, o); o += 4
    objs = {}
    for _ in range(nobj):
        o = (o + 3) & ~3
        path_id, off, size, tidx = struct.unpack_from(E + 'qQIi', d, o); o += 24
        objs[path_id] = (data_offset + off, size, class_ids[tidx])
    return d, E, objs


def read_pptr(d, E, o):
    fid, pid = struct.unpack_from(E + 'iq', d, o)
    return fid, pid, o + 12


def scene_objects(path):
    d, E, objs = parse(path)
    gos, trs = {}, {}
    for pid, (off, size, cid) in objs.items():
        if cid == 1:
            o = off
            (n,) = struct.unpack_from(E + 'i', d, o); o += 4
            comps = []
            for _ in range(n):
                fid, cp, o = read_pptr(d, E, o)
                comps.append(cp)
            o += 4  # layer
            (ln,) = struct.unpack_from(E + 'i', d, o); o += 4
            name = d[o:o + ln].decode('utf-8', 'replace')
            gos[pid] = (name, comps)
        elif cid in (4, 224):
            o = off
            _, go, o = read_pptr(d, E, o)
            q = struct.unpack_from(E + '4f', d, o); o += 16
            p = struct.unpack_from(E + '3f', d, o); o += 12
            s = struct.unpack_from(E + '3f', d, o); o += 12
            (nc,) = struct.unpack_from(E + 'i', d, o); o += 4
            o += 12 * nc
            _, father, o = read_pptr(d, E, o)
            trs[pid] = (go, q, p, s, father)
    return gos, trs


def qmul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return (aw*bx + ax*bw + ay*bz - az*by,
            aw*by - ax*bz + ay*bw + az*bx,
            aw*bz + ax*by - ay*bx + az*bw,
            aw*bw - ax*bx - ay*by - az*bz)


def qrot(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    # v' = q * v * q^-1
    tx = 2 * (y*vz - z*vy); ty = 2 * (z*vx - x*vz); tz = 2 * (x*vy - y*vx)
    return (vx + w*tx + (y*tz - z*ty), vy + w*ty + (z*tx - x*tz), vz + w*tz + (x*ty - y*tx))


def world_positions(trs):
    cache = {}

    def get(pid, depth=0):
        if pid in cache:
            return cache[pid]
        t = trs.get(pid)
        if t is None or depth > 200:
            return None
        go, q, p, s, father = t
        if father == 0 or father not in trs:
            res = (p, q, s)
        else:
            parent = get(father, depth + 1)
            if parent is None:
                res = (p, q, s)
            else:
                pp, pq, ps = parent
                scaled = (p[0]*ps[0], p[1]*ps[1], p[2]*ps[2])
                r = qrot(pq, scaled)
                res = ((pp[0]+r[0], pp[1]+r[1], pp[2]+r[2]), qmul(pq, q), (s[0]*ps[0], s[1]*ps[1], s[2]*ps[2]))
        cache[pid] = res
        return res
    return get


def main():
    data_dir, names_file, out_file = sys.argv[1:4]
    wanted = json.load(open(names_file, encoding='utf-8'))
    exact = {n for n in wanted if not n.startswith('re:')}
    regexes = [re.compile(n[3:]) for n in wanted if n.startswith('re:')]
    levels = sorted((f for f in os.listdir(data_dir) if re.fullmatch(r'level\d+', f)), key=lambda f: int(f[5:]))
    found = []
    for lv in levels:
        try:
            gos, trs = scene_objects(os.path.join(data_dir, lv))
        except Exception as e:  # noqa: BLE001
            print(lv, 'skipped:', e, file=sys.stderr)
            continue
        get = world_positions(trs)
        tr_by_go = {go: pid for pid, (go, *_rest) in trs.items()}
        hits = 0
        for gid, (name, comps) in gos.items():
            if name in exact or any(r.search(name) for r in regexes):
                tp = tr_by_go.get(gid)
                w = get(tp) if tp is not None else None
                if w:
                    found.append({'level': lv, 'name': name, 'x': round(w[0][0], 2), 'y': round(w[0][1], 2), 'z': round(w[0][2], 2)})
                    hits += 1
        print(lv, len(gos), 'objects,', hits, 'hits', file=sys.stderr)
    json.dump(found, open(out_file, 'w', encoding='utf-8'), indent=0)
    print(len(found), 'positions written', file=sys.stderr)


if __name__ == '__main__':
    main()
