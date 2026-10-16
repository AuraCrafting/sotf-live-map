// Caves and bunkers as maps you can read, from their outlines in data/underground.js: 2 m cells, each with
// the height of the floor there. Those cells are samples, so rooms come out dotty and a few heights are off
// (a ceiling at 97 m in a 64 m room). SOTF_CAVES.analyse(area) turns an outline into:
//   floors   the heights many cells share (flat ones, at least 4 m apart), lowest first; cells within 3 m
//            of one are on it, the rest are ramps and shafts. Only levels that lie over each other (one you
//            could walk under or over, down a ladder, stairs or a rope) are floors of their own; the others
//            go together, so a cave that just slopes or steps down is one floor with no ramps, and the map
//            shows no floor chips for it
//   layers   per floor (and one for the ramps and shafts), the cells with the gaps between them filled:
//            grown by a cell in every direction, then shrunk back from the four sides (three cells for
//            caves, which are sampled much more sparsely than bunkers)
//   floorOf  the floor of each outline cell (-1: ramps and shafts)
// Heights are smoothed first: each cell takes the median of the cells within two steps of it that are on
// about its level (or of all of them, for one on its own like that ceiling).
(() => {
  'use strict';

  const FLOOR_GAP = 4; // metres between two floors at least
  const FLOOR_NEAR = 3; // a cell within this of a floor's height is on that floor
  const MAX_FLOORS = 5; // as many as there are colours for
  const SPECK = 3; // a group made from fewer outline cells than this isn't drawn
  // two levels lie over each other when (outlines from objects) this many cells of one have the other's on
  // both sides within 4 m, or (outlines from floor meshes, a cell for each floor) they share this many spots
  const STACK = 8;
  const STACK_SHARED = 25; // 100 m²: a ledge or a bridge over a passage isn't a floor of its own
  const key = (gx, gz) => gx * 65536 + gz; // grid steps stay well within +-32768
  const unkey = (id) => { const gx = Math.round(id / 65536); return [gx, id - gx * 65536]; };

  function median(values) {
    const s = values.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function analyse(area) {
    const c = area.cell;
    const n = area.cells.length;
    const gx = new Int32Array(n);
    const gz = new Int32Array(n);
    const y = new Float32Array(n);
    const at = new Map(); // grid spot -> the outline cells there (a cave can have floors over each other)
    area.cells.forEach(([x, z, h], k) => {
      gx[k] = Math.round(x / c);
      gz[k] = Math.round(z / c);
      y[k] = h;
      const id = key(gx[k], gz[k]);
      if (!at.has(id)) at.set(id, []);
      at.get(id).push(k);
    });

    // 1. smoothed heights
    const sm = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const all = [];
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (Math.abs(dx) + Math.abs(dz) > 2) continue;
          for (const j of at.get(key(gx[k] + dx, gz[k] + dz)) || []) all.push(y[j]);
        }
      }
      const level = all.filter((v) => Math.abs(v - y[k]) <= 8);
      sm[k] = median(level.length >= 3 ? level : all);
    }

    // 2. floors: peaks of the heights, in 1 m steps, that are flat (most cells near one are within 1.5 m)
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of sm) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const base = Math.floor(lo) - 3;
    const bins = Math.ceil(hi) - base + 4;
    const hist = new Float32Array(bins);
    for (const v of sm) hist[Math.round(v) - base]++;
    const smooth = hist.map((_, i) => [1, 2, 3, 2, 1].reduce((s, w, d) => s + w * (hist[i + d - 2] || 0), 0));
    const peaks = [];
    for (let i = 1; i < bins - 1; i++) if (smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1]) peaks.push(i);
    peaks.sort((a, b) => smooth[b] - smooth[a]);
    const within = (h, r) => { let m = 0; for (const v of sm) if (Math.abs(v - h) <= r) m++; return m; };
    const need = Math.max(12, n * 0.05);
    let floors = [];
    for (const i of peaks) {
      const h = i + base;
      if (floors.some((f) => Math.abs(f - h) < FLOOR_GAP)) continue;
      // a slope isn't a floor: on a floor most cells near its height are within 1.5 m of it (not looking as
      // far as the next floor, at least 4 m away)
      if (within(h, FLOOR_NEAR) < need || within(h, 1.5) < 0.5 * within(h, 3.5)) continue; // an even slope: 3/7
      floors.push(h);
      if (floors.length === MAX_FLOORS) break;
    }
    floors.sort((a, b) => a - b);
    const floorOf = new Int8Array(n);
    const nearest = (v) => {
      let best = -1;
      let d = FLOOR_NEAR;
      floors.forEach((f, i) => { if (Math.abs(v - f) <= d) { d = Math.abs(v - f); best = i; } });
      return best;
    };
    for (let k = 0; k < n; k++) floorOf[k] = nearest(sm[k]);

    // 3. levels side by side are one floor. An outline from the floor meshes ("v": 2) has a cell for each
    // floor where two lie over each other, so stacked levels share spots. One from objects has a cell per
    // spot, sampled from whichever level: there, stacked levels come out mixed together, cells of one with
    // the other's on both sides; where levels only meet, at a step or the end of a slope, hardly any are.
    // Lowest first, each floor joins the nearest group it doesn't lie over.
    const spots = floors.map(() => new Set());
    for (let k = 0; k < n; k++) if (floorOf[k] >= 0) spots[floorOf[k]].add(key(gx[k], gz[k]));
    const shared = (a, b) => { let m = 0; for (const id of a) if (b.has(id)) m++; return m; };
    const between = (a, b) => { // cells of a with b on both sides
      let m = 0;
      for (const id of a) {
        const [x, z] = unkey(id);
        const near = (dx, dz) => b.has(key(x + dx, z + dz)) || b.has(key(x + 2 * dx, z + 2 * dz));
        if ((near(1, 0) && near(-1, 0)) || (near(0, 1) && near(0, -1))) m++;
      }
      return m;
    };
    const stacked = (i, j) => (area.v >= 2
      ? shared(spots[i], spots[j]) >= STACK_SHARED
      : between(spots[i], spots[j]) + between(spots[j], spots[i]) >= STACK);
    const groups = [];
    floors.forEach((_, f) => {
      const g = [...groups].reverse().find((members) => members.every((o) => !stacked(o, f)));
      if (g) g.push(f);
      else groups.push([f]);
    });
    if (groups.length < 2) {
      floorOf.fill(0); // one floor: the ramps and shafts are part of it too
      floors = [{ h: Math.round(median(sm) * 10) / 10, cells: n }];
    } else {
      // a slope between floors of one group (within 3 m of its lowest and highest) belongs to it
      const span = groups.map((members) => [floors[members[0]] - FLOOR_NEAR, floors[members.at(-1)] + FLOOR_NEAR]);
      const groupOf = new Int8Array(floors.length);
      groups.forEach((members, g) => { for (const f of members) groupOf[f] = g; });
      for (let k = 0; k < n; k++) {
        if (floorOf[k] >= 0) { floorOf[k] = groupOf[floorOf[k]]; continue; }
        const fits = span.flatMap(([lo, hi], g) => (sm[k] >= lo && sm[k] <= hi ? [g] : []));
        if (fits.length === 1) floorOf[k] = fits[0];
      }
      // each floor at the median height of its cells, lowest first
      floors = groups.map((_, g) => {
        const on = [];
        for (let k = 0; k < n; k++) if (floorOf[k] === g) on.push(sm[k]);
        return { h: Math.round(median(on) * 10) / 10, cells: on.length, was: g };
      }).sort((a, b) => a.h - b.h);
      const order = new Int8Array(groups.length);
      floors.forEach((f, i) => { order[f.was] = i; delete f.was; });
      for (let k = 0; k < n; k++) if (floorOf[k] >= 0) floorOf[k] = order[floorOf[k]];
    }

    // 4. per floor, the gaps filled
    const r = area.kind === 'bunker' ? 1 : 3;
    const layers = [];
    let gx0 = Infinity; let gz0 = Infinity; let gx1 = -Infinity; let gz1 = -Infinity;
    for (let f = -1; f < floors.length; f++) {
      const own = new Map(); // grid spot -> this layer's outline cells there
      for (let k = 0; k < n; k++) {
        if (floorOf[k] !== f) continue;
        const id = key(gx[k], gz[k]);
        if (!own.has(id)) own.set(id, []);
        own.get(id).push(k);
      }
      if (!own.size) continue;
      let set = new Set(own.keys());
      for (let s = 0; s < r; s++) {
        const grown = new Set(set);
        for (const id of set) {
          const [x, z] = unkey(id);
          for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) grown.add(key(x + dx, z + dz));
        }
        set = grown;
      }
      for (let s = 0; s < r; s++) {
        const shrunk = new Set();
        for (const id of set) {
          const [x, z] = unkey(id);
          if (set.has(key(x + 1, z)) && set.has(key(x - 1, z)) && set.has(key(x, z + 1)) && set.has(key(x, z - 1))) shrunk.add(id);
        }
        set = shrunk;
      }
      for (const id of own.keys()) set.add(id);
      // specks, groups made from a few outline cells on their own, are stray samples (a ceiling, a beam),
      // not part of the floor
      const done = new Set();
      for (const id of [...set]) {
        if (done.has(id)) continue;
        const part = [id];
        done.add(id);
        for (let i = 0; i < part.length; i++) {
          const [x, z] = unkey(part[i]);
          for (const next of [key(x + 1, z), key(x - 1, z), key(x, z + 1), key(x, z - 1)]) {
            if (set.has(next) && !done.has(next)) { done.add(next); part.push(next); }
          }
        }
        if (part.filter((p) => own.has(p)).length < SPECK) for (const p of part) set.delete(p);
      }
      if (!set.size) continue;
      const cells = [];
      for (const id of set) {
        const [x, z] = unkey(id);
        const src = []; // the outline cells it comes from: once you've seen one of them, you've seen it
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (const k of own.get(key(x + dx, z + dz)) || []) src.push(k);
        cells.push({ gx: x, gz: z, src });
        gx0 = Math.min(gx0, x); gz0 = Math.min(gz0, z); gx1 = Math.max(gx1, x); gz1 = Math.max(gz1, z);
      }
      layers.push({ floor: f, cells, has: set });
    }
    let ramps = 0;
    for (let k = 0; k < n; k++) if (floorOf[k] < 0) ramps++;
    return { cell: c, floors, ramps, floorOf, layers, at, gx0, gz0, gx1, gz1, key };
  }

  window.SOTF_CAVES = { analyse };
})();
