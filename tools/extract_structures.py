"""Read the names of buildable structures (guide-book recipes) from the game's asset files.

python -I extract_structures.py "<game>/SonsOfTheForest_Data" ../web/data/structures.json

Writes {"<structure id>": "<display name>"}; the map uses it to name what is in your camps.
"""
import json
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unity_scene import parse  # noqa: E402


def read_str(d, E, o):
    (n,) = struct.unpack_from(E + 'i', d, o)
    o += 4
    if n < 0 or n > 200:
        return None, o
    raw = d[o:o + n]
    o = (o + n + 3) & ~3
    try:
        return raw.decode('utf-8'), o
    except UnicodeDecodeError:
        return None, o


def nice(name):
    name = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', name)       # TreeHouse -> Tree House
    return {'Lean To': 'Lean-To', 'Look Out Tower': 'Lookout Tower'}.get(name, name)


def main():
    data_dir, out = sys.argv[1:3]
    files = ['resources.assets'] + sorted(f for f in os.listdir(data_dir) if re.fullmatch(r'sharedassets\d+\.assets', f))
    names = {}
    for fn in files:
        try:
            d, E, objs = parse(os.path.join(data_dir, fn))
        except Exception:  # noqa: BLE001 - not a serialized file we can read
            continue
        for off, size, cid in objs.values():
            if cid != 114 or not 60 <= size <= 20000:  # MonoBehaviour (ScriptableObject) data
                continue
            o = off + 12 + 4 + 12  # m_GameObject, m_Enabled (+pad), m_Script
            obj_name, o = read_str(d, E, o)
            if not obj_name or not obj_name.endswith('Recipe'):
                continue
            (rid,) = struct.unpack_from(E + 'i', d, o)
            display, o = read_str(d, E, o + 4)
            loc, o = read_str(d, E, o)
            # StructureRecipe: _id, _displayName, _localizationId (BLUEPRINT_...)
            if display and loc and 'BLUEPRINT' in loc:
                names.setdefault(str(rid), nice(display))
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(dict(sorted(names.items(), key=lambda kv: int(kv[0]))), f, indent=0, ensure_ascii=False)
    print(len(names), 'structure names written to', out)


if __name__ == '__main__':
    main()
