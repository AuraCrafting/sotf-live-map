"""Unpacks a UnityFS asset bundle (LZ4/LZ4HC or uncompressed blocks) into its files, standard library only."""
import lzma
import os
import struct


def lz4_block(src, size):
    """Decompresses one LZ4 block (the raw block format, no frame) to `size` bytes."""
    dst = bytearray(size)
    i = o = 0
    n = len(src)
    while i < n:
        token = src[i]; i += 1
        lit = token >> 4
        if lit == 15:
            while True:
                b = src[i]; i += 1
                lit += b
                if b != 255:
                    break
        dst[o:o + lit] = src[i:i + lit]
        i += lit; o += lit
        if i >= n:
            break
        off = src[i] | (src[i + 1] << 8); i += 2
        ml = token & 15
        if ml == 15:
            while True:
                b = src[i]; i += 1
                ml += b
                if b != 255:
                    break
        ml += 4
        start = o - off
        if off >= ml:
            dst[o:o + ml] = dst[start:start + ml]
        else:  # overlapping copy: repeat the pattern
            for k in range(ml):
                dst[o + k] = dst[start + k]
        o += ml
    return bytes(dst[:o])


def decompress(data, kind, size):
    if kind == 0:
        return data
    if kind in (2, 3):
        return lz4_block(data, size)
    if kind == 1:
        props, dict_size = data[0], struct.unpack_from('<I', data, 1)[0]
        lc, lp, pb = props % 9, (props // 9) % 5, props // 45
        dec = lzma.LZMADecompressor(lzma.FORMAT_RAW, filters=[{'id': lzma.FILTER_LZMA1, 'dict_size': dict_size, 'lc': lc, 'lp': lp, 'pb': pb}])
        return dec.decompress(data[5:], size)
    raise ValueError(f'compression {kind}')


def unpack(path, out_dir):
    """Writes the bundle's files into out_dir; returns their names."""
    with open(path, 'rb') as f:
        d = f.read()
    o = d.index(b'\0') + 1
    version = struct.unpack_from('>I', d, o)[0]; o += 4
    o = d.index(b'\0', o) + 1
    o = d.index(b'\0', o) + 1
    total, csize, usize, flags = struct.unpack_from('>qIII', d, o); o += 20
    if version >= 7:
        o = (o + 15) & ~15
    if flags & 0x80:  # blocks info at the end
        info = d[len(d) - csize:]
        data_start = o
    else:
        info = d[o:o + csize]
        data_start = o + csize
    info = decompress(info, flags & 0x3F, usize)
    if flags & 0x200:
        data_start = (data_start + 15) & ~15
    p = 16  # uncompressed data hash
    (nblocks,) = struct.unpack_from('>i', info, p); p += 4
    blocks = []
    for _ in range(nblocks):
        u, c, fl = struct.unpack_from('>IIH', info, p); p += 10
        blocks.append((u, c, fl))
    (nnodes,) = struct.unpack_from('>i', info, p); p += 4
    nodes = []
    for _ in range(nnodes):
        off, size, fl = struct.unpack_from('>qqI', info, p); p += 20
        e = info.index(b'\0', p)
        nodes.append((off, size, info[p:e].decode('utf-8', 'replace')))
        p = e + 1
    out = bytearray()
    at = data_start
    for u, c, fl in blocks:
        out += decompress(d[at:at + c], fl & 0x3F, u)
        at += c
    os.makedirs(out_dir, exist_ok=True)
    names = []
    for off, size, name in nodes:
        dest = os.path.join(out_dir, os.path.basename(name))
        with open(dest, 'wb') as f:
            f.write(out[off:off + size])
        names.append(os.path.basename(name))
    return names
