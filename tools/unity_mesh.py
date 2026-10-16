"""Reads Mesh objects (class 43) from Unity 2022 player asset files (SerializedFile v22, no type trees):
vertex positions and triangles, with the vertex data inline or in the .resS file next to it.
Big files are memory-mapped, so only the parts asked for are read."""
import mmap
import os
import struct

FORMAT_SIZE = [4, 2, 1, 1, 2, 2, 1, 1, 2, 2, 4, 4]  # VertexFormat: Float32, Float16, UNorm8, SNorm8, UNorm16, ...


class Asset:
    def __init__(self, path):
        self.path = path
        self.f = open(path, 'rb')
        self.d = mmap.mmap(self.f.fileno(), 0, access=mmap.ACCESS_READ)
        d = self.d
        if struct.unpack_from('>I', d, 8)[0] < 22:
            raise ValueError('unsupported version')
        big = d[16] != 0
        self.E = E = '>' if big else '<'
        _, _, self.data_offset = struct.unpack_from('>IQQ', d, 20)
        o = 48
        o = d.find(b'\0', o) + 1  # unity version
        o += 4
        trees = d[o] != 0  # bundles keep the type trees: skipped, the data is laid out the same
        o += 1
        (ntypes,) = struct.unpack_from(E + 'i', d, o); o += 4
        cids = []
        for _ in range(ntypes):
            cid, _, script_idx = struct.unpack_from(E + 'i?h', d, o); o += 7
            if cid == 114 or script_idx >= 0:
                o += 16
            o += 16
            if trees:
                nodes, strings = struct.unpack_from(E + 'ii', d, o); o += 8 + 32 * nodes + strings
                (deps,) = struct.unpack_from(E + 'i', d, o); o += 4 + 4 * deps
            cids.append(cid)
        (nobj,) = struct.unpack_from(E + 'i', d, o); o += 4
        self.objs = {}
        for _ in range(nobj):
            o = (o + 3) & ~3
            pid, off, size, tidx = struct.unpack_from(E + 'qQIi', d, o); o += 24
            self.objs[pid] = (self.data_offset + off, size, cids[tidx])
        self.ress = None

    def string(self, o):
        (n,) = struct.unpack_from(self.E + 'i', self.d, o)
        s = bytes(self.d[o + 4:o + 4 + n]).decode('utf-8', 'replace')
        return s, (o + 4 + n + 3) & ~3

    def mesh(self, pid):
        """(name, [(x, y, z)], [(i, j, k)]) of a Mesh in this file, triangles of every submesh."""
        off, size, cid = self.objs[pid]
        if cid != 43:
            raise ValueError(f'object {pid} is class {cid}, not a Mesh')
        d, E = self.d, self.E
        u32 = lambda o: struct.unpack_from(E + 'I', d, o)[0]
        i32 = lambda o: struct.unpack_from(E + 'i', d, o)[0]
        name, o = self.string(off)
        nsub = i32(o); o += 4
        subs = []
        for _ in range(nsub):
            first_byte, index_count, topology, base_vertex, first_vertex, vertex_count = struct.unpack_from(E + 'IIiIII', d, o)
            subs.append((first_byte, index_count, topology, base_vertex))
            o += 24 + 24
        n = i32(o); o += 4 + 40 * n               # blend shape vertices
        n = i32(o); o += 4 + 12 * n               # blend shapes
        n = i32(o); o += 4                         # blend shape channels
        for _ in range(n):
            _, o = self.string(o); o += 12
        n = i32(o); o += 4 + 4 * n                # full weights
        n = i32(o); o += 4 + 64 * n               # bind poses
        n = i32(o); o += 4 + 4 * n                # bone name hashes
        o += 4                                     # root bone name hash
        n = i32(o); o += 4 + 24 * n               # bones AABB
        n = i32(o); o += 4 + 4 * n                # variable bone count weights
        compression = d[o]; o += 4                 # + readable, keep vertices, keep indices
        index_format = i32(o); o += 4
        n = i32(o); index_buffer = bytes(d[o + 4:o + 4 + n]); o = (o + 4 + n + 3) & ~3
        vertex_count = u32(o); o += 4
        nch = i32(o); o += 4
        channels = [tuple(d[o + 4 * k:o + 4 * k + 4]) for k in range(nch)]; o += 4 * nch
        n = i32(o); vertex_data = bytes(d[o + 4:o + 4 + n]); o = (o + 4 + n + 3) & ~3
        if compression:
            raise ValueError(f'{name}: compressed mesh')
        if not vertex_data:  # streamed: the object ends with offset (u64), size (u32) and the .resS name
            tail = bytes(d[off:off + size])
            k = tail.rfind(b'.resS')
            if k < 0:
                raise ValueError(f'{name}: no vertex data')
            for ln in range(6, 260):  # the name ends at ".resS": find its length prefix
                p = k + 5 - ln
                if p >= 4 and struct.unpack_from(E + 'i', tail, p - 4)[0] == ln:
                    s_off, s_size = struct.unpack_from(E + 'QI', tail, p - 16)
                    break
            else:
                raise ValueError(f'{name}: stream info not found')
            if self.ress is None:
                rf = open(self.path + '.resS', 'rb')
                self.ress = mmap.mmap(rf.fileno(), 0, access=mmap.ACCESS_READ)
            vertex_data = bytes(self.ress[s_off:s_off + s_size])
        # streams: channels by stream; each stream's data follows the last, aligned to 16
        strides = {}
        for stream, offset, fmt, dim in channels:
            if dim:
                strides[stream] = strides.get(stream, 0) + FORMAT_SIZE[fmt] * (dim & 0xF)
        starts, at = {}, 0
        for s in sorted(strides):
            starts[s] = at
            at = (at + strides[s] * vertex_count + 15) & ~15
        stream, offset, fmt, dim = channels[0]
        if fmt != 0 or (dim & 0xF) < 3:
            raise ValueError(f'{name}: positions not float3 ({fmt}, {dim})')
        base, stride = starts[stream] + offset, strides[stream]
        verts = [struct.unpack_from(E + '3f', vertex_data, base + v * stride) for v in range(vertex_count)]
        isz = 2 if index_format == 0 else 4
        tris = []
        for first_byte, index_count, topology, base_vertex in subs:
            if topology != 0:
                continue
            idx = struct.unpack_from(E + ('H' if isz == 2 else 'I') * index_count, index_buffer, first_byte)
            for t in range(0, index_count - 2, 3):
                tris.append((idx[t] + base_vertex, idx[t + 1] + base_vertex, idx[t + 2] + base_vertex))
        return name, verts, tris


def externals(path):
    """The files a serialized file's PPtr file ids point to (file id n = entry n - 1; 0 is the file itself)."""
    with open(path, 'rb') as f:
        d = f.read(min(os.path.getsize(path), 64 << 20))
    E = '>' if d[16] != 0 else '<'
    o = d.index(b'\0', 48) + 1 + 4 + 1
    (ntypes,) = struct.unpack_from(E + 'i', d, o); o += 4
    for _ in range(ntypes):
        cid, _, script_idx = struct.unpack_from(E + 'i?h', d, o); o += 7
        if cid == 114 or script_idx >= 0:
            o += 16
        o += 16
    (nobj,) = struct.unpack_from(E + 'i', d, o); o += 4
    for _ in range(nobj):
        o = ((o + 3) & ~3) + 24
    (nscript,) = struct.unpack_from(E + 'i', d, o); o += 4
    for _ in range(nscript):
        o = ((o + 4 + 3) & ~3) + 8
    (next_,) = struct.unpack_from(E + 'i', d, o); o += 4
    out = []
    for _ in range(next_):
        o = d.index(b'\0', o) + 1 + 16 + 4
        e = d.index(b'\0', o)
        out.append(d[o:e].decode('utf-8', 'replace'))
        o = e + 1
    return out
