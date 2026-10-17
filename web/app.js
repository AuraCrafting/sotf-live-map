(() => {
  'use strict';

  const CATS = window.SOTF_CATEGORIES;
  const LOCS = window.SOTF_LOCATIONS;
  const CAT = Object.fromEntries(CATS.map((c) => [c.key, c]));
  const BY_ID = new Map(LOCS.map((l) => [l.id, l]));
  const GROUPS = [...new Set(CATS.map((c) => c.group))];
  // Progress tiles at the top of the sidebar. Ponds, graves and loot crates would drown out the numbers.
  const SUMMARY = [
    { label: 'Places', group: 'Places', skip: ['water', 'grave'] },
    { label: 'Gear', group: 'Gear', skip: [] },
    { label: 'Collectibles', group: 'Collectibles', skip: [] },
  ];
  // Places that count as "visited" once you have been right at them: within AUTO_RADIUS metres of the marker
  // (a village is big, and a lake's marker is in the middle of it; the rest you have to walk up to).
  const AUTO_MARK = new Set(['camp', 'village', 'poi', 'spawn', 'grave', 'water', 'cave', 'bunker']);
  const AUTO_RADIUS = { village: 20, water: 30, other: 10 };
  const PIN_KINDS = {
    base: { label: 'Base', color: '#ff7b22', glyph: 'B' },
    stash: { label: 'Stash', color: '#c9a21a', glyph: 'S' },
    danger: { label: 'Danger', color: '#d64545', glyph: '!' },
    note: { label: 'Note', color: '#4b8fd6', glyph: 'N' },
  };
  const $ = (sel) => document.querySelector(sel);

  // ---------- per-device preferences ----------
  const PREFS_KEY = 'sotf-live-map-prefs';
  const storedPrefs = readJSON(PREFS_KEY);
  const firstVisit = !Object.keys(storedPrefs).length; // nothing saved on this device yet: the welcome shows
  const prefs = Object.assign(
    { hidden: CATS.filter((c) => !c.visible).map((c) => c.key), hideFound: false, showTrail: true, showExplored: false, fog: 35, fogOn: { explore: true, guide: false }, trailRange: 'today', autoMark: true, autoMarkedUpTo: 0, darkMap: true, mode: 'explore', guideNoWarn: false },
    storedPrefs
  );
  // The fog as of 3.2: on or off per mode with the Fog button (on in Explore, off in Guide), starting thin;
  // the pale "where you've been" wash is off unless you turn it on in the trail menu.
  if ((prefs.fogV || 0) < 2) Object.assign(prefs, { fog: 35, fogOn: { explore: true, guide: false }, showExplored: false, fogV: 2 });
  const hidden = new Set(prefs.hidden);
  function savePrefs() {
    prefs.hidden = [...hidden];
    writeJSON(PREFS_KEY, prefs);
  }
  function readJSON(key) {
    try {
      // settings saved under the map's earlier name (SOTF Field Map) carry over once
      const old = key.replace('sotf-live-map-', 'sotf-field-map-');
      if (localStorage.getItem(key) == null && localStorage.getItem(old) != null) {
        localStorage.setItem(key, localStorage.getItem(old));
        localStorage.removeItem(old);
      }
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch { return {}; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: keep going */ }
  }

  // ---------- shared progress (server, or this browser when offline) ----------
  const LOCAL_KEY = 'sotf-live-map-progress';
  const store = { found: new Set(), pins: [], trail: [], position: null, info: null, online: false, world: null,
    worlds: new Map(), active: null, view: null, viewPinned: false, target: null,
    encountered: new Set(), revealed: new Set(), seen: new Set(), probable: new Set(), dismissed: new Set(),
    explored: new Map(), exploredUnder: new Map() }; // world -> its explored cells, and per cave (see "fog" below) // see "Explore and Guide" below
  const MARK_LISTS = ['encountered', 'revealed', 'seen', 'probable', 'dismissed'];
  // No game on screen yet: not playing, and you haven't picked one ("Which game?" below)
  const unchosen = () => !store.view && store.worlds.size > 0;
  let cave = null; // the cave or bunker being shown instead of the island, or null
  let onFoundChange = null; // the welcome's count of what your saves marked, while it's open
  let welcomeStep = 0; // the welcome's step on screen (0: closed)
  let brush = null; // the fog brush while it's on: { world } (see "the fog brush" below)
  let heldToast = null; // a message that came while the welcome was open: shown when it closes

  async function api(path, body) {
    const res = await fetch('/api/' + path, body === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }
  function saveLocal() {
    writeJSON(LOCAL_KEY, { found: [...store.found], pins: store.pins, ...Object.fromEntries(MARK_LISTS.map((k) => [k, [...store[k]]])) });
  }

  // ---------- Explore and Guide ----------
  // Explore ("where have I been") shows what you know: what you found, what you chose to reveal (the red
  // spoiler buttons), everything where you've cleared the fog, and locked spots you came across, so you can
  // see what you need to get further.
  // Guide ("get me there") shows everything. Switching never changes your progress, only what's shown.
  const exploring = () => prefs.mode !== 'guide';
  const entranceLike = (l) => (l.c === 'cave' || l.c === 'bunker') && !l.g;
  // what a spot needs that you carry (keycards, tools); an entrance it needs is just the way in ("Way in")
  const needsOf = (l) => (l.r || []).map((id) => BY_ID.get(id)).filter((n) => n && !entranceLike(n));
  const LOCKS = LOCS.filter((l) => needsOf(l).length);
  const ENCOUNTER_RADIUS = 40;
  // null, 'locked' (you don't have what it needs yet) or 'open' (you do, and haven't been back)
  function lockState(l) {
    if (!l || !needsOf(l).length || store.found.has(l.id)) return null;
    return needsOf(l).every((n) => store.found.has(n.id)) ? 'open' : 'locked';
  }
  // ---------- on the same level ----------
  // The trail keeps your height and whether you were underground. A step only counts for a spot on the same
  // level: walking over a bunker on the surface isn't being at the things inside it, and a cave under a camp
  // isn't the camp.
  const isUnderground = (l) => !!l.g?.some((g) => /cave|bunker|underground/i.test(g)) || (!!l.a && !entranceLike(l));
  function floorHeight(l) { // the cave or bunker floor under a spot, from the outlines
    const a = l.a && AREA[l.a];
    if (!a) return null;
    const cx = Math.round(l.x / a.cell);
    const cz = Math.round(l.y / a.cell);
    for (let r = 0; r <= 3; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const y = a.lookup.get(`${cx + dx},${cz + dz}`);
          if (y !== undefined) return y;
        }
      }
    }
    return null;
  }
  function wasUnder(p) {
    if (typeof p.cave === 'boolean') return p.cave; // your live position
    if (p.c) return true; // an underground step
    if (p.s === 'live') return false;
    return p.h != null && !!areaAt(p.x, p.y, p.h, { reach: 3, dy: 6, need: 3 }); // a save: from its height
  }
  function sameLevel(p, l) {
    const under = isUnderground(l);
    if (wasUnder(p) !== under) return false;
    if (!under || p.h == null) return true;
    const floor = floorHeight(l);
    return floor == null || Math.abs(p.h - floor) < 15;
  }

  let uncovered = new Set(); // spots whose fog you've cleared (see "what's under the fog" below)
  function knows(l) {
    return store.found.has(l.id) || store.revealed.has(l.id) || store.encountered.has(l.id) || uncovered.has(l.id)
      || store.target?.id === `loc:${l.id}` || !!l.parked?.moved || store.seen.has(l.id) || store.probable.has(l.id);
  }
  // a locked spot you came across (or cleared the fog over): shows as a lock, not what's behind it
  const lockSeen = (l) => store.encountered.has(l.id) || uncovered.has(l.id);
  // a locked spot you came across but haven't looked into: what's there stays hidden in Explore
  // Once you have what it needs it's no longer locked: it shows what it is, ringed as unlocked
  const hiddenLock = (l) => exploring() && lockState(l) === 'locked' && lockSeen(l) && !store.revealed.has(l.id);
  const nameOf = (l) => (hiddenLock(l) ? 'Locked spot' : nice(l.t));
  function lockTitle(l) {
    if (lockState(l) === 'open') return 'Unlocked · you can open it now';
    return `Locked · needs ${needsOf(l).filter((n) => !store.found.has(n.id)).map((n) => nice(n.t)).join(' and ')}`;
  }
  const LOCK_SVG = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>';
  const OPEN_SVG = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 017.6-1.8"/></svg>';

  async function persistMarks(kind, ids, on = true) {
    if (!store.online) return saveLocal();
    try {
      await api('marks', { kind, ids, on, world: store.view });
    } catch {
      toast('Could not save. Is the map window on your PC still open?');
    }
  }
  function reveal(ids) {
    const fresh = ids.filter((id) => !store.revealed.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => store.revealed.add(id));
    persistMarks('revealed', fresh);
    refreshKnown(fresh);
  }
  function refreshKnown(ids) {
    (ids || LOCS.map((l) => l.id)).forEach(paintMarker);
    applyFilters();
    renderUnlock();
  }
  async function persist(path, body) {
    if (!store.online) return saveLocal();
    if (store.view) body = { ...body, world: store.view };
    try {
      await api(path, body);
    } catch {
      toast('Could not save. Is the map window on your PC still open?');
    }
  }

  // ---------- map ----------
  const mapEl = $('#map');
  const map = L.map(mapEl, {
    crs: L.CRS.Simple,
    minZoom: -3,
    maxZoom: 3,
    zoomSnap: 0.5,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    zoomControl: false,
    attributionControl: false,
    maxBounds: [[-2700, -2700], [2700, 2700]],
    maxBoundsViscosity: 0.8,
    tapHold: true,
  });
  const Tiles = L.TileLayer.extend({
    getTileUrl(c) {
      const z = c.z + 4;
      const offset = 2 ** (z - 1);
      return `tiles/${z}-${c.x + offset}-${c.y + offset}.webp`;
    },
    // Also load a ring of tiles around the view (padTiles), so they're there before they scroll in.
    _getTiledPixelBounds(center) {
      const b = L.TileLayer.prototype._getTiledPixelBounds.call(this, center);
      const pad = this.getTileSize().multiplyBy(this.options.padTiles || 0);
      return L.bounds(b.min.subtract(pad), b.max.add(pad));
    },
  });
  const TILES = { tileSize: 250, minZoom: -3, maxZoom: 3, bounds: [[-2000, -2000], [2000, 2000]], noWrap: true, className: 'sotf-tiles' };
  // Underneath: the whole island from its 16 coarsest tiles, so a spot that hasn't loaded yet shows a blurry
  // map instead of an empty square, and the sharp tile fades in on top.
  new Tiles('', { ...TILES, minNativeZoom: -2, maxNativeZoom: -2, padTiles: 4, zIndex: 0, updateWhenIdle: false }).addTo(map);
  // Load tiles while the map moves (phones otherwise wait until it stops), and keep more of them around.
  new Tiles('', {
    ...TILES, minNativeZoom: -3, maxNativeZoom: 0, zIndex: 1,
    updateWhenIdle: false, updateInterval: 100, keepBuffer: 4, padTiles: 1,
  }).addTo(map);
  map.fitBounds([[-1900, -1900], [1900, 1900]]);

  // Leaflet's flyTo fails (NaN) when the target is exactly the current centre, e.g. "Center on me" while
  // following; zoom there instead.
  function flyTo(ll, zoom, options) {
    const off = map.latLngToContainerPoint(ll).subtract(map.getSize().divideBy(2));
    if (Math.abs(off.x) < 1 && Math.abs(off.y) < 1) return map.setView(ll, zoom, { animate: true });
    return map.flyTo(ll, zoom, options);
  }

  function markerSize() {
    const px = Math.round(Math.max(16, Math.min(38, 30 + map.getZoom() * 4.5)));
    mapEl.style.setProperty('--m', px + 'px');
  }
  map.on('zoomend', markerSize);
  markerSize();

  // ---------- location markers ----------
  const markers = new Map();
  const locLayer = L.layerGroup().addTo(map);

  // ---------- markers on top of each other fan out ----------
  // PC: hovering a pile spreads it on a circle (a spiral for big piles) with a leg to each real spot.
  // Phone: the first tap on a pile spreads it, a tap on a spread marker opens it.
  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const legLayer = L.layerGroup().addTo(map);
  let spread = null; // { members: [{ mk, p }], center, radius }

  function markerPx() { return parseFloat(mapEl.style.getPropertyValue('--m')) || 30; }
  function spreadCandidates() {
    return [...locLayer.getLayers(), ...pinLayer.getLayers(), ...campLayer.getLayers()].filter((mk) => mk.getElement());
  }
  // Markers whose icons overlap the hovered one, linked transitively (a chain of overlaps is one pile).
  function overlapGroup(marker) {
    const m = markerPx();
    const start = map.latLngToContainerPoint(marker.getLatLng());
    const pts = spreadCandidates().map((mk) => ({ mk, p: map.latLngToContainerPoint(mk.getLatLng()) }))
      .filter((o) => o.p.distanceTo(start) <= m * 3);
    const group = [{ mk: marker, p: start }];
    const inGroup = new Set([marker]);
    for (let i = 0; i < group.length && group.length < 40; i++) {
      for (const o of pts) {
        if (inGroup.has(o.mk) || o.p.distanceTo(group[i].p) > m * 0.75) continue;
        inGroup.add(o.mk);
        group.push(o);
        if (group.length >= 40) break;
      }
    }
    return group;
  }

  function spreadOut(marker) {
    if (spread?.members.some((o) => o.mk === marker)) return true;
    collapseSpread();
    const group = overlapGroup(marker);
    const n = group.length;
    if (n < 2) return false;
    const m = markerPx();
    const center = group.reduce((sum, o) => sum.add(o.p), L.point(0, 0)).divideBy(n);
    const offsets = [];
    if (n < 10) {
      const r = Math.max(m * 1.1, (n * m * 1.3) / (2 * Math.PI));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI - Math.PI / 2;
        offsets.push(L.point(Math.cos(a) * r, Math.sin(a) * r));
      }
    } else { // spiral, as in OverlappingMarkerSpiderfier
      let leg = m * 1.1;
      let a = 0;
      for (let i = 0; i < n; i++) {
        a += (m * 1.15) / leg + i * 0.0005;
        offsets.push(L.point(Math.cos(a) * leg, Math.sin(a) * leg));
        leg += (2 * Math.PI * m * 0.17) / a;
      }
    }
    group.forEach((o, i) => {
      const el = o.mk.getElement();
      if (!el) return;
      const target = center.add(offsets[i]);
      const d = target.subtract(o.p);
      el.style.setProperty('--sx', `${d.x}px`);
      el.style.setProperty('--sy', `${d.y}px`);
      el.classList.add('spread');
      o.z = o.mk.options.zIndexOffset || 0;
      o.mk.setZIndexOffset(6000);
      if (n <= 12 && o.mk.options.title) {
        const label = document.createElement('span');
        label.className = `spread-label${offsets[i].x < -1 ? ' left' : ''}`;
        label.textContent = nice(el.title || o.mk.options.title);
        el.appendChild(label);
      }
      L.polyline([o.mk.getLatLng(), map.containerPointToLatLng(target)], {
        color: '#f4efe6', weight: 1.4, opacity: 0.75, interactive: false,
      }).addTo(legLayer);
    });
    L.circleMarker(map.containerPointToLatLng(center), {
      radius: 3.5, color: '#f4efe6', weight: 1.5, fillColor: '#101412', fillOpacity: 1, interactive: false,
    }).addTo(legLayer);
    spread = { members: group, center, radius: Math.max(...offsets.map((p) => Math.hypot(p.x, p.y))) };
    return true;
  }

  function collapseSpread() {
    if (!spread) return;
    for (const o of spread.members) {
      const el = o.mk.getElement();
      if (el) {
        el.style.removeProperty('--sx');
        el.style.removeProperty('--sy');
        el.classList.remove('spread');
        el.querySelector('.spread-label')?.remove();
      }
      o.mk.setZIndexOffset(o.z || 0);
    }
    legLayer.clearLayers();
    spread = null;
  }

  // Every marker that can be in a pile opens through this.
  function tapToSelect(marker, open) {
    if (canHover) marker.on('mouseover', () => { if (!draft) spreadOut(marker); });
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (draft) return moveDraft(e.originalEvent ? map.mouseEventToLatLng(e.originalEvent) : e.latlng);
      const inSpread = spread?.members.some((o) => o.mk === marker);
      if (!canHover && !inSpread && spreadOut(marker)) return; // phone: first tap only fans the pile out
      collapseSpread();
      open();
    });
  }
  map.on('mousemove', (e) => {
    if (spread && e.containerPoint.distanceTo(spread.center) > spread.radius + markerPx()) collapseSpread();
  });
  map.on('zoomstart dragstart click', collapseSpread);

  function createMarker(l) {
    const c = CAT[l.c];
    const icon = L.divIcon({
      className: 'loc',
      html: `<span class="pin-dot" style="--c:${c.color}"><img src="icons/${l.i}.webp" alt=""></span>`,
      iconSize: [0, 0],
    });
    const m = L.marker([l.y, l.x], { icon, title: l.t, alt: l.t, riseOnHover: true });
    m.iconHtml = `<img src="icons/${l.i}.webp" alt="">`;
    tapToSelect(m, () => select({ kind: 'loc', id: l.id }));
    m.on('add', () => paintMarker(l.id));
    markers.set(l.id, m);
  }
  LOCS.forEach(createMarker);

  function paintMarker(id) {
    const m = markers.get(id);
    const el = m?.getElement();
    if (!el) return;
    const l = BY_ID.get(id);
    el.classList.toggle('found', store.found.has(id));
    el.classList.toggle('selected', selected?.kind === 'loc' && selected.id === id);
    const state = lockState(l);
    el.classList.toggle('locked', state === 'locked');
    el.classList.toggle('unlocked', state === 'open');
    el.classList.toggle('probable', store.probable.has(id) && !store.found.has(id));
    el.classList.toggle('other-floor', otherFloor(l));
    // in Explore a locked spot you've seen shows a lock, not what's behind it
    const look = hiddenLock(l) ? state : 'item';
    const dot = el.querySelector('.pin-dot');
    if (dot && dot.dataset.look !== look) {
      dot.innerHTML = look === 'item' ? m.iconHtml : look === 'open' ? OPEN_SVG : LOCK_SVG;
      dot.dataset.look = look;
    }
    el.title = look === 'item' ? l.t : lockTitle(l);
  }

  // Markers well outside the view stay off the map until you get near them.
  function nearView() {
    const b = map.getBounds();
    return b.isValid() ? b.pad(0.5) : null;
  }
  function applyFilters() {
    if (cave) campLayer.remove(); // camps are on the island
    else if (!map.hasLayer(campLayer)) campLayer.addTo(map);
    const near = nearView();
    for (const l of LOCS) {
      const isSelected = selected?.kind === 'loc' && selected.id === l.id;
      // In a cave or bunker view every item of that place shows, whatever the category filters say.
      const shown = cave ? l.a === cave.id : !hidden.has(l.c);
      const visible = isSelected || (shown && !(prefs.hideFound && store.found.has(l.id)) && (!near || near.contains([l.y, l.x]))
        && (!exploring() || knows(l)));
      const m = markers.get(l.id);
      const on = locLayer.hasLayer(m);
      if (visible && !on) locLayer.addLayer(m);
      else if (!visible && on) locLayer.removeLayer(m);
    }
    drawClimbs();
  }

  map.on('moveend', () => { if (!spread) applyFilters(); }); // markers coming near the view

  // ---------- custom pins ----------
  const pinLayer = L.layerGroup().addTo(map);
  const pinMarkers = new Map();
  function drawPins() {
    pinLayer.clearLayers();
    pinMarkers.clear();
    for (const p of store.pins) {
      const k = PIN_KINDS[p.kind] || PIN_KINDS.note;
      const icon = L.divIcon({
        className: 'loc custom-pin' + (selected?.kind === 'pin' && selected.id === p.id ? ' selected' : ''),
        html: `<span class="pin-dot" style="--c:${k.color}"><span>${k.glyph}</span></span>`,
        iconSize: [0, 0],
      });
      const m = L.marker([p.y, p.x], { icon, title: p.label || k.label, zIndexOffset: 500 });
      tapToSelect(m, () => select({ kind: 'pin', id: p.id }));
      pinLayer.addLayer(m);
      pinMarkers.set(p.id, m);
    }
    renderPinList();
  }

  // ---------- a new pin: a draft you move around, then place ----------
  // The pin button, right-click and long-press put a draft pin on the map. Each tap moves it there (a tap on
  // a marker too, so it can sit right next to one), and it can be dragged. Nothing is saved until
  // "Place pin"; Cancel, Esc or switching worlds throws it away. There's only ever one.
  let draft = null; // { marker, kind }
  const draftBar = $('#draft-bar');
  $('#draft-kinds').innerHTML = Object.entries(PIN_KINDS).map(([key, v]) => `
    <button type="button" data-draft-kind="${key}" aria-pressed="false">
      <span class="ico" style="--c:${v.color}"><span style="font:700 12px var(--font-display);color:#fff">${v.glyph}</span></span>${v.label}
    </button>`).join('');
  function startDraft(latlng) {
    if (draft) return moveDraft(latlng);
    if (selected) closeDetail();
    collapseSpread();
    const marker = L.marker(latlng, {
      icon: L.divIcon({ className: 'loc custom-pin draft-pin', html: '<span class="pin-dot"><span></span></span>', iconSize: [0, 0] }),
      draggable: true, keyboard: false, zIndexOffset: 6000, title: 'New pin: drag it, or tap the map',
    }).addTo(map);
    marker.on('drag', renderDraft);
    marker.on('dblclick', (e) => { L.DomEvent.stopPropagation(e); placeDraft(); });
    marker.on('contextmenu', (e) => { L.DomEvent.stopPropagation(e); if (canHover) endDraft(); }); // right-click on it: cancel
    draft = { marker, kind: 'note' };
    const verb = canHover ? 'Click' : 'Tap';
    $('#draft-hint').classList.toggle('repeat', !!prefs.pinHintSeen);
    $('#draft-hint').textContent = prefs.pinHintSeen ? `${verb} the map to move the pin`
      : `${verb} the map to move the pin, or Place pin to keep it`;
    if (!prefs.pinHintSeen) { prefs.pinHintSeen = true; savePrefs(); }
    $('#add-pin').setAttribute('aria-pressed', 'true');
    document.body.classList.add('drafting');
    draftBar.hidden = false;
    // on a PC the controls sit next to the pin (and move with it); on a phone they're a bar at the bottom
    if (!phoneLayout.matches) {
      draftBar.classList.add('pop');
      draft.popup = L.popup({ closeButton: false, autoClose: false, closeOnClick: false, className: 'draft-pop', offset: [0, -30], maxWidth: 340 })
        .setContent(draftBar);
      marker.bindPopup(draft.popup).openPopup();
    }
    renderDraft();
  }
  function moveDraft(latlng) {
    const el = draft.marker.getElement();
    el?.classList.add('moving'); // a short glide to the new spot
    draft.marker.setLatLng(latlng);
    setTimeout(() => el?.classList.remove('moving'), 220);
    renderDraft();
  }
  function renderDraft() {
    if (!draft) return;
    const { lat, lng } = draft.marker.getLatLng();
    const k = PIN_KINDS[draft.kind];
    const dot = draft.marker.getElement()?.querySelector('.pin-dot');
    if (dot) { dot.style.setProperty('--c', k.color); dot.firstElementChild.textContent = k.glyph; }
    const pos = store.position;
    let where = '';
    if (pos) {
      const d = Math.hypot(lng - pos.x, lat - pos.y);
      where = d < 15 ? ' · where you are' : ` · ${fmtDist(d)} ${compass(lng - pos.x, lat - pos.y)} of ${pos.source === 'live' ? 'you' : 'your last save'}`;
    }
    $('#draft-where').textContent = `X ${Math.round(lng)} · Z ${Math.round(lat)}${where}`;
    for (const b of draftBar.querySelectorAll('[data-draft-kind]')) b.setAttribute('aria-pressed', b.dataset.draftKind === draft.kind);
  }
  function endDraft() {
    if (!draft) return;
    map.removeLayer(draft.marker);
    draft = null;
    draftBar.hidden = true;
    draftBar.classList.remove('pop');
    $('#app').append(draftBar); // back from the pin's popup
    document.body.classList.remove('drafting');
    $('#add-pin').setAttribute('aria-pressed', 'false');
  }
  function placeDraft() {
    const { lat, lng } = draft.marker.getLatLng();
    const pin = { id: 'p' + Date.now().toString(36), x: round(lng), y: round(lat), label: '', kind: draft.kind };
    endDraft();
    store.pins.push(pin);
    drawPins();
    select({ kind: 'pin', id: pin.id, fresh: true }); // the pin's card, to name it
    persist('pins', { action: 'save', pin });
  }
  draftBar.addEventListener('click', (e) => {
    // Not on to the map: Place and Cancel move this bar out of the pin's popup, after which Leaflet would take
    // the click for one on the map, and start a new pin there.
    e.stopPropagation();
    const kind = e.target.closest('[data-draft-kind]');
    if (kind && draft) { draft.kind = kind.dataset.draftKind; return renderDraft(); }
    const act = e.target.closest('[data-draft]')?.dataset.draft;
    if (act === 'place' && draft) placeDraft();
    if (act === 'cancel') endDraft();
  });

  function updatePin(pin) {
    drawPins();
    persist('pins', { action: 'save', pin });
  }

  function deletePin(id) {
    store.pins = store.pins.filter((p) => p.id !== id);
    closeDetail();
    drawPins();
    persist('pins', { action: 'delete', pin: { id } });
  }

  // ---------- gliding markers ----------
  // The game sends positions about twice a second. Instead of jumping, a marker glides from where it is
  // to the new spot over about the time between updates (linear, so walking speed looks steady), and
  // turns the short way round. Far jumps (a teleport, a respawn) and the first update after a pause jump.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const GLIDE_JUMP_M = 60;
  const GLIDE_STALE_S = 3;
  class Glide {
    constructor(apply) { this.apply = apply; this.shown = null; this.to = null; this.last = 0; this.frame = 0; }
    go(p, { live = true } = {}) {
      const now = performance.now();
      const since = (now - this.last) / 1000;
      this.last = now;
      const prev = this.shown;
      if (!prev || !live || reduceMotion.matches || since > GLIDE_STALE_S || Math.hypot(p.x - prev.x, p.y - prev.y) > GLIDE_JUMP_M) {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.to = null;
        this.show(p);
        return;
      }
      this.from = { ...prev };
      this.to = { ...p };
      this.start = now;
      this.dur = Math.min(1000, Math.max(250, since * 1050)); // a touch longer than the gap, so it never stops between updates
      if (!this.frame) this.frame = requestAnimationFrame((t) => this.step(t));
    }
    step(now) {
      this.frame = 0;
      if (!this.to) return;
      const t = Math.min(1, (now - this.start) / this.dur);
      const { from, to } = this;
      const turn = from.h == null || to.h == null ? null : ((to.h - from.h) % 360 + 540) % 360 - 180;
      this.show({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, h: turn == null ? to.h : from.h + turn * t });
      if (t < 1) this.frame = requestAnimationFrame((n) => this.step(n));
      else this.to = null;
    }
    show(p) {
      this.shown = p;
      if (!map._animatingZoom) this.apply(p); // mid-zoom the next frame catches up
    }
  }

  // ---------- you ----------
  let meMarker = null;
  let meKey = null;
  let following = false;
  let zoomStartAt = 0; // a zoom or fly in progress (Leaflet skips zoomend when one is interrupted, hence the time limit)
  const meGlide = new Glide((p) => {
    meMarker.setLatLng([p.y, p.x]);
    const arrow = meMarker.getElement()?.querySelector('.me .arrow');
    if (arrow && p.h != null) arrow.style.transform = `rotate(${p.h}deg)`;
    if (guideLine) guideLine.setLatLngs([[p.y, p.x], guideLine.getLatLngs()[1]]);
    if (following) followCamera(p);
  });

  function drawMe() {
    const pos = store.position;
    const elsewhere = unchosen() || !!(pos?.world && store.view && pos.world !== store.view);
    if (meMarker) meMarker.getElement()?.classList.toggle('hidden-world', !!elsewhere);
    if (!pos || elsewhere) { drawOthers(); updateStatus(); return; }
    if (!meMarker) {
      const icon = L.divIcon({
        className: 'me-icon',
        html: '<div class="me"><div class="ring"></div><div class="arrow"></div><div class="core"></div></div>',
        iconSize: [0, 0],
      });
      meMarker = L.marker([pos.y, pos.x], { icon, interactive: false, keyboard: false, zIndexOffset: 3000 }).addTo(map);
    }
    const me = meMarker.getElement()?.querySelector('.me');
    if (me) {
      me.classList.toggle('save', pos.source === 'save');
      me.querySelector('.arrow').hidden = pos.heading == null;
    }
    const key = `${pos.time}|${pos.x}|${pos.y}|${pos.heading}`;
    if (key !== meKey) { // drawMe also runs for other reasons; only a new position moves the marker
      meKey = key;
      meGlide.go({ x: pos.x, y: pos.y, h: pos.heading }, { live: pos.source === 'live' });
    }
    updateCave();
    noteEncounters();
    drawOthers();
    drawGuide();
    updateStatus();
    if (selected) refreshDetail();
  }

  // A locked spot counts as encountered once you've been within 40 m of it, or inside its cave or bunker.
  // Kept per world (progress.json), whatever the mode: it's where you have been.
  let encounterChecked = 0; // trail points already looked at
  const VEHICLE_SIGHT = 75;
  const UNDER_SIGHT = 15; // like the cave fog: what you see around you underground
  function noteEncounters(extra = []) {
    const pos = store.position;
    if (!pos || (store.view && store.active && store.view !== store.active)) return;
    const world = store.view || pos.world;
    if (encounterChecked > store.trail.length) encounterChecked = 0; // the trail was replaced
    const pts = store.trail.slice(encounterChecked).filter((p) => !world || !p.w || p.w === world).concat(extra);
    encounterChecked = store.trail.length;
    if (pos.source === 'live') pts.push(pos);
    const inside = cave && !cave.manual ? cave.id : null;
    const hits = LOCKS.filter((l) => !store.encountered.has(l.id) && !store.found.has(l.id)
      && ((inside && l.a === inside) || pts.some((p) => Math.hypot(p.x - l.x, p.y - l.y) <= ENCOUNTER_RADIUS && sameLevel(p, l))));
    // Golf carts, gliders and the Knight V show in Explore once you've seen one (been within 75 m of it, on the
    // surface, at about its height) or moved it; the in-game GPS lists all of them, so that alone doesn't count.
    const saw = LOCS.filter((l) => l.c === 'vehicle' && !store.seen.has(l.id) && pts.some((p) => !wasUnder(p)
      && Math.hypot(p.x - l.x, p.y - l.y) <= VEHICLE_SIGHT && (p.h == null || l.h == null || Math.abs(p.h - l.h) < 30)));
    // Everything else shows once its fog is gone (see "what's under the fog"), but a few underground spots
    // have no cave outline to keep fog for: those show once you've been near them down there.
    saw.push(...LOCS.filter((l) => !AREA[l.a] && isUnderground(l) && !needsOf(l).length && !knows(l)
      && pts.some((p) => Math.hypot(p.x - l.x, p.y - l.y) <= UNDER_SIGHT && sameLevel(p, l))));
    if (saw.length) {
      saw.forEach((l) => store.seen.add(l.id));
      persistMarks('seen', saw.map((l) => l.id));
      refreshKnown(saw.map((l) => l.id));
    }
    if (!hits.length) return;
    hits.forEach((l) => store.encountered.add(l.id));
    persistMarks('encountered', hits.map((l) => l.id));
    refreshKnown(hits.map((l) => l.id));
  }

  // While following, the map moves with the gliding marker a frame at a time, without pan animations of
  // its own. Tiles load as it moves; the trail and cave outlines redraw a few times a second.
  let followMoveEnd = 0;
  let followMoveEndAt = 0;
  function followCamera(p) {
    if (map._animatingZoom || map.touchZoom?._zooming || map._panAnim?._inProgress || performance.now() - zoomStartAt < 1000) return;
    const off = map.latLngToContainerPoint([p.y, p.x]).subtract(map.getSize().divideBy(2)).round();
    if (!off.x && !off.y) return;
    if (!map._rawPanBy) return map.panBy(off, { animate: false, noMoveStart: true });
    map._rawPanBy(off);
    map.fire('move');
    const now = performance.now();
    clearTimeout(followMoveEnd);
    if (now - followMoveEndAt > 300) {
      followMoveEndAt = now;
      map.fire('moveend');
    } else {
      followMoveEnd = setTimeout(() => { followMoveEndAt = performance.now(); map.fire('moveend'); }, 300);
    }
  }
  function setFollowing(on) {
    following = on;
    $('#follow').setAttribute('aria-pressed', on);
    // zooming with the wheel, a pinch or a double tap keeps you in the middle while following
    for (const k of ['scrollWheelZoom', 'touchZoom', 'doubleClickZoom']) map.options[k] = on ? 'center' : true;
  }
  map.on('zoomstart', () => { zoomStartAt = performance.now(); });
  map.on('zoomend', () => {
    zoomStartAt = 0;
    if (meMarker && meGlide.shown) meGlide.apply(meGlide.shown);
  });

  // ---------- companions, other players and GPS markers (live from the mod) ----------
  const MATES = { kelvin: { name: 'Kelvin', color: '#5aa9e6' }, virginia: { name: 'Virginia', color: '#e07ab8' } };
  const othersLayer = L.layerGroup().addTo(map);
  const mateMarkers = new Map();
  const tagLayer = L.layerGroup().addTo(map);
  const tagMarkers = new Map();
  // The in-game GPS's icon types (its own label is just a letter for most of them).
  const GPS_TYPES = {
    6: { name: 'Cave', like: (l) => l.c === 'cave' && !l.g },
    7: { name: 'GPS locator', like: (l) => l.c === 'gps' },
    17: { name: 'Mercenary GPS locator', like: (l) => l.c === 'gps' },
    18: { name: 'Worker GPS locator', like: (l) => l.c === 'gps' },
    19: { name: 'Golf cart', vehicle: true },
    20: { name: 'Glider', vehicle: true },
  };

  function liveFresh() {
    const pos = store.position;
    return pos && pos.source === 'live' && Date.now() / 1000 - pos.time < 20;
  }
  // In a cave view only what is in that cave shows; on the island everything does.
  function visibleHere(o) {
    if (!cave) return true;
    return areaAt(o.x, o.y, o.h)?.id === cave.id;
  }

  // Virginia is out on the island from the start, and the game always knows where. Explore shows her once
  // you've met her: she came within 40 m of you, or your saves say she has come to see you. Kelvin is with you.
  const VIRGINIA_MET = -1; // kept in the world's "seen" list (the rest of it are vehicles' location ids)
  const MEET_DIST = 40;
  function metVirginia() {
    return store.seen.has(VIRGINIA_MET) || store.worlds.get(store.view)?.history?.virginia > 0;
  }
  function noteVirginia(o, pos) {
    if (o.k !== 'virginia' || o.dead || metVirginia() || pos.source !== 'live' || !store.view || store.view !== pos.world) return;
    if (Math.hypot(o.x - pos.x, o.y - pos.y) > MEET_DIST || (o.h != null && pos.h != null && Math.abs(o.h - pos.h) > 15)) return;
    store.seen.add(VIRGINIA_MET);
    persistMarks('seen', [VIRGINIA_MET]);
    toast('You met Virginia. She shows on the map from now on.');
  }

  function drawOthers() {
    const pos = store.position;
    // live, and on the map of the game being played (not another one you're looking at)
    const here = liveFresh() && !unchosen() && (!store.view || !pos.world || store.view === pos.world);
    const others = here ? pos.others || [] : [];
    const seen = new Set();
    others.forEach((o, i) => {
      if (!visibleHere(o)) return;
      noteVirginia(o, pos);
      if (o.k === 'virginia' && exploring() && !metVirginia()) return;
      const mate = MATES[o.k];
      const key = o.k === 'player' ? `p:${o.n || i}` : `${o.k}:${i}`;
      const name = mate ? mate.name : o.n || 'Player';
      const color = mate ? mate.color : o.c || '#7fd58f';
      seen.add(key);
      let m = mateMarkers.get(key);
      if (!m) {
        const mk = L.marker([o.y, o.x], {
          icon: L.divIcon({ className: 'me-icon', html: '<div class="mate"><div class="arrow"></div><div class="core"></div><span class="label"></span></div>', iconSize: [0, 0] }),
          interactive: false, keyboard: false, zIndexOffset: 2500,
        }).addTo(othersLayer);
        mk.glide = new Glide((p) => {
          mk.setLatLng([p.y, p.x]);
          const arrow = mk.getElement()?.querySelector('.mate .arrow');
          if (arrow && p.h != null) arrow.style.transform = `rotate(${p.h}deg)`;
        });
        mateMarkers.set(key, m = mk);
      }
      if (m.seenAt !== pos.time) { // a new update from the game (drawOthers also runs for other reasons)
        m.seenAt = pos.time;
        m.glide.go({ x: o.x, y: o.y, h: o.heading || 0 });
      }
      const el = m.getElement()?.querySelector('.mate');
      if (el) {
        el.style.setProperty('--c', color);
        el.classList.toggle('dead', !!o.dead);
        el.querySelector('.label').textContent = o.dead ? `${name} (dead)` : name;
      }
    });
    for (const [key, m] of mateMarkers) {
      if (!seen.has(key)) { cancelAnimationFrame(m.glide.frame); othersLayer.removeLayer(m); mateMarkers.delete(key); }
    }

    const tagsSeen = new Set();
    const nth = new Map();
    for (const t of here ? pos.tags || [] : []) {
      if (!visibleHere(t)) continue;
      const type = GPS_TYPES[t.i];
      if (type?.vehicle && !t.a) continue; // vehicles have their own markers (in Explore once you've seen or moved them)
      // The game's own markers (caves, GPS locators) are on your GPS from the start: Explore leaves them for
      // you to find by going there. Guide shows every place already. Trackers you put out still show.
      if (type?.like && exploring()) continue;
      if (type?.like && LOCS.some((l) => type.like(l) && Math.hypot(l.x - t.x, l.y - t.y) < 25)) continue;
      const label = t.t?.trim().length > 1 ? t.t : t.a ? 'GPS tracker (moving)' : type ? type.name : `GPS marker (type ${t.i ?? '?'})`;
      const color = t.c || '#38c6d9';
      const base = `${label}|${color}`;
      nth.set(base, (nth.get(base) || 0) + 1);
      const key = `${base}|${nth.get(base)}`; // trackers keep their marker while they move
      tagsSeen.add(key);
      const m = tagMarkers.get(key);
      if (m) { m.setLatLng([t.y, t.x]); continue; }
      tagMarkers.set(key, L.marker([t.y, t.x], {
        icon: L.divIcon({ className: 'me-icon', html: `<div class="tag-dot" style="--c:${esc(color)}"></div>`, iconSize: [0, 0] }),
        keyboard: false, zIndexOffset: 1500,
      }).bindTooltip(esc(label), { direction: 'top', offset: [0, -8] }).addTo(tagLayer));
    }
    for (const [key, m] of tagMarkers) {
      if (!tagsSeen.has(key)) { tagLayer.removeLayer(m); tagMarkers.delete(key); }
    }
  }

  // The chip says where the position comes from; phones get a short version ("Live", "Day 17 · 21m").
  function updateStatus() {
    const btn = $('#status');
    const text = $('#status-text');
    const pos = store.position;
    btn.classList.remove('live', 'save');
    let long;
    let short;
    const raw = store.serverPosition;
    const playing = raw?.source === 'live' && Date.now() / 1000 - raw.time < 20;
    if (unchosen()) {
      long = 'Not playing · pick a save, or start the game';
      short = 'Not playing';
    } else if (playing && raw.world && store.view !== raw.world) {
      // looking at another game than the one you play
      btn.classList.add('save');
      const w = store.worlds.get(store.view);
      long = `Viewing ${worldName(w)}${w?.day != null ? ` · Day ${w.day}` : ''} · you're playing another game`;
      short = w?.day != null ? `Other world · Day ${w.day}` : 'Other world';
    } else if (pos && pos.source === 'live' && Date.now() / 1000 - pos.time < 20) {
      btn.classList.add('live');
      long = cave && !cave.manual ? `Live · ${cave.name}` : 'Live position';
      short = 'Live';
    } else if (pos) {
      btn.classList.add('save');
      const day = pos.day != null ? `Day ${pos.day} · ` : '';
      const newest = store.worlds.get(store.view)?.saveList?.[0];
      const which = pos.source === 'save' && newest && pos.time < newest.time - 1 ? 'Save' : pos.source === 'live' ? 'Last seen' : 'Last save';
      long = `${which} · ${day}${ago(pos.time)}`;
      short = `${day}${agoShort(pos.time)}`;
    } else if (!store.online) {
      long = 'Offline · progress kept in this browser';
      short = 'Offline';
    } else {
      const none = store.info && !store.info.savesFound;
      long = none ? 'No save games found on this PC' : 'Save the game to show where you are';
      short = none ? 'No saves' : 'No position';
    }
    text.innerHTML = `<span class="long">${esc(long)}</span><span class="short">${esc(short)}</span>`;
    btn.title = long;
  }
  setInterval(() => { updateCave(); updateStatus(); }, 5000); // also leaves the cave view once the live feed stops

  // ---------- where you've been ----------
  const trailRenderer = L.canvas({ padding: 0.3 });
  const trailLayer = L.layerGroup().addTo(map);
  function currentTrail() {
    if (unchosen()) return [];
    const world = store.view || store.position?.world;
    return store.trail.filter((p) => !world || !p.w || p.w === world);
  }
  // What the trail menu shows: the last hour, today (since midnight) or everything. Only the drawing is
  // filtered; nothing is deleted.
  const TRAIL_RANGES = { hour: 'the last hour', today: 'today', all: 'all' };
  if (!TRAIL_RANGES[prefs.trailRange]) prefs.trailRange = 'today';
  function trailSince() {
    if (prefs.trailRange === 'hour') return Date.now() / 1000 - 3600;
    if (prefs.trailRange === 'today') return new Date().setHours(0, 0, 0, 0) / 1000;
    return 0;
  }
  function shownTrail() {
    const since = trailSince();
    return currentTrail().filter((p) => p.t >= since);
  }
  // Long sessions get dense: steps closer than 8 m to the last one drawn are left out (saves always stay).
  function thin(pts) {
    const out = [];
    let last = null;
    for (const p of pts) {
      if (p.s !== 'save' && last && Math.hypot(p.x - last.x, p.y - last.y) < 8) continue;
      out.push(p);
      last = p;
    }
    return out;
  }
  // Where you've been, from your saves: a soft wash about 28 m around everything you changed in the world
  // (see changedPoints). The circles are drawn solid on their own canvas, and its pane is see-through, so
  // where they overlap they merge into one area instead of getting darker.
  map.createPane('explored').style.zIndex = 240; // over the map, under the cave veil and everything else
  const exploredRenderer = L.canvas({ pane: 'explored', padding: 0.3 });
  const exploredLayer = L.layerGroup().addTo(map);
  const EXPLORED_RADIUS = 28;
  let exploredDrawn = null;
  function drawExplored() {
    const w = store.worlds.get(store.view);
    const groups = w?.history?.changed;
    const sig = [store.view, prefs.showExplored, !!cave, groups?.length, groups?.at(-1)?.t].join('|');
    if (sig === exploredDrawn) return;
    exploredDrawn = sig;
    exploredLayer.clearLayers();
    if (!prefs.showExplored || cave || !groups?.length) return;
    const drawn = new Set();
    for (const p of changedPoints(w)) {
      if (p.cave) continue; // underground: not on the island's surface
      const k = `${Math.round(p.x / 8)},${Math.round(p.y / 8)}`; // closer points don't show under a 28 m circle
      if (drawn.has(k)) continue;
      drawn.add(k);
      L.circle([p.y, p.x], {
        radius: EXPLORED_RADIUS, stroke: false, fillColor: '#efe9dc', fillOpacity: 1, renderer: exploredRenderer, interactive: false,
      }).addTo(exploredLayer);
    }
  }
  // ---------- fog (Explore): the part of the island you haven't explored ----------
  // The map app keeps, per world, which 10 m cells of the island you've seen: around you as you play, where
  // you saved, what you changed in the world, your camps and the places you found (store.explored). Explore
  // covers the rest in mist, as thick as the Fog slider says (0 is none, 100 hides the map there). It's one
  // canvas for the whole island, stretched over it like an image, so moving the map costs nothing; it's only
  // painted again when cells are added. Guide, and the cave and bunker view, have no fog.
  const GRID = { cell: 10, min: -2000, size: 400 };
  const FOG_PX = 2; // canvas pixels per cell (5 m each)
  map.createPane('fog').style.zIndex = 245; // over the map and the explored wash, under the cave veil and everything else
  map.getPane('fog').style.pointerEvents = 'none';
  const CanvasOverlay = L.ImageOverlay.extend({ // Leaflet's image overlay, with a canvas for the image
    _initImage() {
      const el = (this._image = this._url);
      L.DomUtil.addClass(el, 'leaflet-image-layer');
      if (this._zoomAnimated) L.DomUtil.addClass(el, 'leaflet-zoom-animated');
      if (this.options.className) L.DomUtil.addClass(el, this.options.className);
    },
  });
  const fogHoles = document.createElement('canvas'); // one pixel per cell, opaque where explored
  fogHoles.width = fogHoles.height = GRID.size;
  const fogCanvas = document.createElement('canvas');
  fogCanvas.width = fogCanvas.height = GRID.size * FOG_PX;
  const fogEnd = GRID.min + GRID.size * GRID.cell;
  const fogLayer = new CanvasOverlay(fogCanvas, [[GRID.min, GRID.min], [fogEnd, fogEnd]], { pane: 'fog', interactive: false, className: 'fog-layer' });
  let fogBits = null; // the explored cells of the world on screen: bit j * 400 + i, lowest bit first
  let fogPainted = null;
  let fogJoined = null; // fogBits with the gaps joined, as the fog shows them (null: work it out again)
  const bitsFrom = (b64) => Uint8Array.from(atob(b64 || ''), (ch) => ch.charCodeAt(0));
  const hasCell = (bits, k) => (bits[k >> 3] >> (k & 7)) & 1;
  const fogActive = () => !!prefs.fogOn?.[exploring() ? 'explore' : 'guide'] && prefs.fog > 0;
  // Clouds: four layers of smooth noise (big banks down to small wisps), light and dark, that tile without
  // seams. Painted over the fog's own colour, so it reads as mist and not as a flat sheet.
  const mist = (() => {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const field = new Float32Array(S * S);
    for (const [n, weight] of [[4, 0.42], [8, 0.3], [16, 0.17], [32, 0.11]]) {
      const g = Array.from({ length: n * n }, rnd);
      const at = (i, j) => g[(j % n) * n + (i % n)];
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const fx = (x / S) * n;
          const fy = (y / S) * n;
          const i = Math.floor(fx);
          const j = Math.floor(fy);
          const u = (fx - i) * (fx - i) * (3 - 2 * (fx - i));
          const v = (fy - j) * (fy - j) * (3 - 2 * (fy - j));
          const top = at(i, j) + (at(i + 1, j) - at(i, j)) * u;
          const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u;
          field[y * S + x] += weight * (top + (bottom - top) * v);
        }
      }
    }
    const img = ctx.createImageData(S, S);
    for (let p = 0; p < S * S; p++) {
      const d = (field[p] - 0.5) * 2.4; // about -1 (a gap in the clouds) to 1 (a thick bank)
      const light = d > 0;
      img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = light ? 255 : 10;
      img.data[p * 4 + 3] = Math.round(Math.min(1, Math.abs(d)) * (light ? 92 : 64));
    }
    ctx.putImageData(img, 0, 0);
    return c;
  })();
  // The explored cells with gaps of up to about 40 m between them joined (grown by two cells, then shrunk
  // back), so the places you went between don't show as specks. The share explored counts the cells themselves.
  const FOG_JOIN = 2;
  function joinedCells(bits) {
    const N = GRID.size;
    const a = new Uint8Array(N * N);
    for (let k = 0; k < N * N; k++) a[k] = hasCell(bits, k);
    const pass = (src, grow) => { // a square max (grow) or min (shrink) filter, rows then columns
      const rows = new Uint8Array(N * N);
      const out = new Uint8Array(N * N);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          let v = grow ? 0 : 1;
          for (let d = -FOG_JOIN; d <= FOG_JOIN; d++) {
            const x = i + d;
            const s = x < 0 || x >= N ? 1 - grow : src[j * N + x];
            v = grow ? v | s : v & s;
          }
          rows[j * N + i] = v;
        }
      }
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          let v = grow ? 0 : 1;
          for (let d = -FOG_JOIN; d <= FOG_JOIN; d++) {
            const y = j + d;
            const s = y < 0 || y >= N ? 1 - grow : rows[y * N + i];
            v = grow ? v | s : v & s;
          }
          out[j * N + i] = v;
        }
      }
      return out;
    };
    const joined = pass(pass(a, 1), 0);
    for (let k = 0; k < N * N; k++) joined[k] |= a[k];
    return joined;
  }
  function fogHolesFromBits() {
    const N = GRID.size;
    const joined = (fogJoined = joinedCells(fogBits));
    const ctx = fogHoles.getContext('2d');
    const img = ctx.createImageData(N, N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) if (joined[j * N + i]) img.data[((N - 1 - j) * N + i) * 4 + 3] = 255; // north is up
    }
    ctx.putImageData(img, 0, 0);
  }
  // Mist everywhere, then the explored cells cut out of it: a wide, faint thinning around them (about 50 m)
  // and a clear inside with a soft edge (about 15 m). With `part` (a box of cells), only around it.
  function paintFog(part) {
    const ctx = fogCanvas.getContext('2d');
    const size = fogCanvas.width;
    let src = [0, 0, GRID.size, GRID.size];
    ctx.save();
    if (part) {
      const pad = 10; // the wide blur reaches this far (in cells), and takes in twice as much
      ctx.beginPath();
      ctx.rect((part.x0 - pad) * FOG_PX, (part.y0 - pad) * FOG_PX, (part.x1 - part.x0 + 1 + 2 * pad) * FOG_PX, (part.y1 - part.y0 + 1 + 2 * pad) * FOG_PX);
      ctx.clip();
      const sx = Math.max(0, part.x0 - 2 * pad);
      const sy = Math.max(0, part.y0 - 2 * pad);
      src = [sx, sy, Math.min(GRID.size, part.x1 + 1 + 2 * pad) - sx, Math.min(GRID.size, part.y1 + 1 + 2 * pad) - sy];
    }
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = prefs.darkMap ? '#6f7c8e' : '#cdd4dc';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = ctx.createPattern(mist, 'repeat');
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.imageSmoothingEnabled = true;
    const holes = () => ctx.drawImage(fogHoles, src[0], src[1], src[2], src[3], src[0] * FOG_PX, src[1] * FOG_PX, src[2] * FOG_PX, src[3] * FOG_PX);
    ctx.filter = 'blur(10px)';
    ctx.globalAlpha = 0.4;
    holes();
    ctx.filter = 'blur(3px)';
    ctx.globalAlpha = 1;
    holes();
    ctx.restore();
  }
  function setFogWorld() {
    fogBits = store.explored.get(store.view) || null;
    fogPainted = null;
    fogJoined = null;
    paintCave();
    drawFog();
    renderExploredStat();
    updateUncovered();
  }
  function drawFog() {
    if (caveDrawn) { // in a cave: its own fog
      if (fogActive() !== caveDrawn.fogOn) paintCave();
      else map.getPane('caveFog').style.opacity = String(1 - prefs.fog / 100);
      renderCaveCount();
    }
    const on = !!fogBits && fogActive() && !cave;
    if (on && fogPainted !== fogBits) { fogHolesFromBits(); paintFog(); fogPainted = fogBits; }
    if (on !== map.hasLayer(fogLayer)) on ? fogLayer.addTo(map) : fogLayer.remove();
    if (on) fogLayer.setOpacity(prefs.fog / 100);
  }
  // New cells (live, as you walk): cut them out and paint just that part again.
  function addExplored(world, cells) {
    const bits = store.explored.get(world);
    if (!bits) return;
    for (const k of cells) bits[k >> 3] |= 1 << (k & 7);
    if (world === store.view) fogChanged();
    if (world !== store.view || fogPainted !== bits) return renderExploredStat();
    repaintAround(cells);
  }
  // Cells of the world on screen changed (added, or the fog brush took some away): paint around them again.
  function repaintAround(cells) {
    fogHolesFromBits();
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const k of cells) {
      const i = k % GRID.size;
      const row = GRID.size - 1 - Math.floor(k / GRID.size);
      x0 = Math.min(x0, i); y0 = Math.min(y0, row); x1 = Math.max(x1, i); y1 = Math.max(y1, row);
    }
    const join = FOG_JOIN * 2; // joining gaps reaches a little further than the new cells
    paintFog({ x0: x0 - join, y0: y0 - join, x1: x1 + join, y1: y1 + join });
    renderExploredStat();
  }

  // How much of the island you've explored: land cells only (not the sea or the lakes), from the island's
  // 16 coarsest map tiles (4 m a pixel), worked out once.
  let land = null; // Uint8Array(160000): 1 = land
  let landCells = 0;
  let landLoading = null;
  function loadLand() {
    landLoading ||= Promise.all([0, 1, 2, 3].flatMap((x) => [0, 1, 2, 3].map((y) => new Promise((ok) => {
      const img = new Image();
      img.onload = () => ok({ img, x, y });
      img.onerror = () => ok(null);
      img.src = `tiles/2-${x}-${y}.webp`;
    })))).then((tiles) => {
      if (tiles.some((t) => !t)) return;
      const c = document.createElement('canvas');
      c.width = c.height = GRID.size; // the 1000 x 1000 pixels of tiles, averaged into one pixel per cell
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      for (const t of tiles) ctx.drawImage(t.img, (t.x * GRID.size) / 4, (t.y * GRID.size) / 4, GRID.size / 4, GRID.size / 4);
      const px = ctx.getImageData(0, 0, GRID.size, GRID.size).data;
      land = new Uint8Array(GRID.size * GRID.size);
      for (let j = 0; j < GRID.size; j++) {
        for (let i = 0; i < GRID.size; i++) {
          const p = ((GRID.size - 1 - j) * GRID.size + i) * 4;
          if (!isWater(px[p], px[p + 1], px[p + 2])) { land[j * GRID.size + i] = 1; landCells++; }
        }
      }
      renderExploredStat();
    });
    return landLoading;
  }
  const isWater = (r, g, b) => b > r + 12 && b > g - 4;
  let statTimer = 0;
  function renderExploredStat() {
    clearTimeout(statTimer);
    statTimer = setTimeout(() => {
      const el = $('#explored-stat');
      const show = !!fogBits && exploring();
      el.hidden = !show;
      if (!show) return;
      if (!land) { loadLand(); return; }
      let n = 0;
      for (let k = 0; k < land.length; k++) if (land[k] && hasCell(fogBits, k)) n++;
      const pct = landCells ? (n * 100) / landCells : 0;
      const shown = pct > 0 && pct < 1 ? pct.toFixed(1) : Math.round(pct);
      el.innerHTML = `<span>Explored</span><b>${shown}%</b> of the island<span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span>`;
      if (!fogMenu.hidden) renderFogMenu();
    }, 150);
  }

  // Live updates arrive twice a second, so the trail isn't drawn again unless something about it changed;
  // a new step on the end is just added to the line.
  let trailDrawn = null; // { sig, ref, count, line, last }
  function drawTrail({ added } = {}) {
    drawExplored();
    drawFog();
    if (!$('#trail-menu').hidden) renderTrailMenu();
    const world = store.view || store.position?.world;
    const since = trailSince();
    const sig = [world, prefs.trailRange, prefs.showTrail, cave?.id, Math.floor(since / 60),
      (store.worlds.get(store.view)?.history?.spots || []).length].join('|');
    const d = trailDrawn;
    if (d && d.sig === sig && d.ref === store.trail) {
      if (d.count === store.trail.length) return; // nothing new
      if (added && d.count === store.trail.length - 1 && d.line && added.s !== 'save') {
        d.count++;
        const mine = !world || !added.w || added.w === world;
        if (!prefs.showTrail || cave || added.c || !mine || added.t < since) return;
        if (d.last && Math.hypot(added.x - d.last.x, added.y - d.last.y) < 8) return;
        d.line.addLatLng([added.y, added.x]);
        d.last = added;
        return;
      }
    }
    trailLayer.clearLayers();
    trailDrawn = { sig, ref: store.trail, count: store.trail.length, line: null, last: null };
    if (!prefs.showTrail || cave || unchosen()) return;
    // Spots close together are one dot: you save at your base again and again, and a stack of dots, each a
    // little off the last, turns into a heavy ring.
    const together = (list, metres) => {
      const groups = [];
      for (const p of list) {
        const g = groups.find((q) => Math.hypot(q.x - p.x, q.y - p.y) < metres);
        if (!g) groups.push({ x: p.x, y: p.y, n: 1, last: p });
        else { g.n++; if ((p.t || 0) > (g.last.t || 0)) g.last = p; }
      }
      return groups;
    };
    for (const sp of together(store.worlds.get(store.view)?.history?.spots || [], 6)) {
      L.circleMarker([sp.y, sp.x], {
        radius: 3.5, color: '#1d0e02', weight: 1.5, fillColor: '#f4efe6', fillOpacity: 0.9, renderer: trailRenderer, className: 'trail-dot',
      }).bindTooltip(sp.n > 1 ? `Your zip lines (${sp.n} ends)` : 'Your zip line', { direction: 'top' }).addTo(trailLayer);
    }
    const pts = thin(shownTrail().filter((p) => !p.c)); // underground steps would scribble over the island
    if (!pts.length) return;
    trailDrawn.last = pts[pts.length - 1];
    if (pts.length > 1) {
      trailDrawn.line = L.polyline(pts.map((p) => [p.y, p.x]), {
        color: '#ff7b22', weight: 2.5, opacity: 0.85, dashArray: '6 7', renderer: trailRenderer, interactive: false,
      }).addTo(trailLayer);
    }
    for (const g of together(pts.filter((p) => p.s === 'save'), 25)) {
      const p = g.last;
      L.circleMarker([g.y, g.x], {
        radius: 4.5, color: '#1d0e02', weight: 1.5, fillColor: '#ff7b22', fillOpacity: 1, renderer: trailRenderer, className: 'trail-dot',
      }).bindTooltip(`${g.n > 1 ? `Saved here ${g.n} times, last` : 'Saved here'} · ${(p.l || '').replace(/_/g, ' ')}<br>${new Date(p.t * 1000).toLocaleString()}`, { direction: 'top' })
        .addTo(trailLayer);
    }
  }

  // ---------- caves and bunkers ----------
  // Outlines come from the game's scene files (data/underground.js): 2 m cells with their height.
  const AREAS = window.SOTF_UNDERGROUND || [];
  const AREA = Object.fromEntries(AREAS.map((a) => [a.id, a]));
  for (const a of AREAS) a.lookup = new Map(a.cells.map(([x, z, y]) => [`${x / a.cell},${z / a.cell}`, y]));
  let caveDismissed = null; // id of a cave the user switched away from while still inside it
  map.createPane('caveVeil').style.zIndex = 250;
  map.createPane('caveCells').style.zIndex = 260;
  const caveLayer = L.layerGroup().addTo(map);
  // ---------- cave and bunker maps ----------
  // Each cave or bunker is drawn once onto two canvases stretched over it (like the island's fog): the parts
  // you've seen, and the parts you haven't. Its floors are in colour (found by caves.js), ramps and shafts
  // in grey, with dark walls where a floor ends and a faint 10 m grid. The floor chips in the banner fade
  // the other floors, and the items on them. Explore's fog: the map app keeps which outline cells you've seen
  // (around you underground, your underground trail, what you changed on its floor, what you found in it);
  // the unseen parts are drawn misty on a pane as see-through as the Fog slider says (hidden at 100). Each
  // floor has its own fog, so the part of floor 2 you haven't been to stays fogged over a floor 1 you have.
  const FLOOR_COLORS = ['hsl(172,34%,46%)', 'hsl(38,64%,58%)', 'hsl(268,30%,64%)', 'hsl(346,46%,62%)', 'hsl(118,28%,52%)'];
  const RAMP_COLOR = 'hsl(220,8%,70%)';
  map.createPane('caveFog').style.zIndex = 259;
  map.getPane('caveFog').style.pointerEvents = 'none';
  const caveMaps = new Map(); // area id -> SOTF_CAVES.analyse(area), worked out the first time it's shown
  const caveMapOf = (area) => {
    if (!caveMaps.has(area.id)) caveMaps.set(area.id, window.SOTF_CAVES.analyse(area));
    return caveMaps.get(area.id);
  };
  const CAVE_PAD = 3; // cells of room around the outline
  let caveDrawn = null; // { area, m, px, fogOn, seenCanvas, unseenCanvas, seen, unseen }
  let caveFloor = { area: null, pick: 'all' }; // the floor filter: 'all', a floor's index, or 'ramps'
  const underBits = (id) => store.exploredUnder.get(store.view)?.get(id) || null;
  const pickOf = (area) => (area && caveFloor.area === area.id ? caveFloor.pick : 'all');
  const layerPick = (layer) => (layer.floor < 0 ? 'ramps' : layer.floor);
  function paintCaveCanvas(canvas, area, m, px, part) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const c = m.cell;
    const left = (m.gx0 - CAVE_PAD) * c - c / 2; // the world x of the canvas's left edge
    const top = (m.gz1 + CAVE_PAD) * c + c / 2; // the world z of its top edge: north is up
    if (part === 'seen') { // a faint 10 m grid
      ctx.fillStyle = 'rgba(255,255,255,.07)';
      for (let x = Math.ceil(left / 10) * 10; (x - left) / c * px < canvas.width; x += 10) ctx.fillRect(Math.round(((x - left) / c) * px), 0, 1, canvas.height);
      for (let z = Math.floor(top / 10) * 10; (top - z) / c * px < canvas.height; z -= 10) ctx.fillRect(0, Math.round(((top - z) / c) * px), canvas.width, 1);
    }
    const fogOn = fogActive();
    const bits = underBits(area.id);
    const pick = pickOf(area);
    // ramps and shafts at the bottom, then the floors from the lowest up, and the floor you picked on top
    const order = [...m.layers].sort((a, b) => (layerPick(a) === pick) - (layerPick(b) === pick) || a.floor - b.floor);
    const wall = Math.max(2, Math.round(px * 0.28));
    for (const layer of order) {
      ctx.globalAlpha = pick === 'all' || layerPick(layer) === pick ? 1 : 0.15;
      const seen = (cl) => !fogOn || (!!bits && cl.src.some((k) => hasCell(bits, k)));
      const mine = layer.cells.filter((cl) => seen(cl) === (part === 'seen'));
      ctx.fillStyle = part === 'unseen' ? 'hsl(212,12%,50%)' : layer.floor < 0 ? RAMP_COLOR : FLOOR_COLORS[layer.floor];
      for (const cl of mine) ctx.fillRect((cl.gx - m.gx0 + CAVE_PAD) * px, (m.gz1 + CAVE_PAD - cl.gz) * px, px, px);
      ctx.fillStyle = part === 'unseen' ? 'rgba(28,36,46,.9)' : 'rgba(10,12,14,.88)'; // walls: where the floor ends
      for (const cl of mine) {
        const x = (cl.gx - m.gx0 + CAVE_PAD) * px;
        const y = (m.gz1 + CAVE_PAD - cl.gz) * px;
        if (!layer.has.has(m.key(cl.gx - 1, cl.gz))) ctx.fillRect(x, y, wall, px);
        if (!layer.has.has(m.key(cl.gx + 1, cl.gz))) ctx.fillRect(x + px - wall, y, wall, px);
        if (!layer.has.has(m.key(cl.gx, cl.gz + 1))) ctx.fillRect(x, y, px, wall);
        if (!layer.has.has(m.key(cl.gx, cl.gz - 1))) ctx.fillRect(x, y + px - wall, px, wall);
      }
    }
    ctx.globalAlpha = 1;
  }
  function drawCaveCells(area) {
    if (caveDrawn) { caveDrawn.seen.remove(); caveDrawn.unseen.remove(); }
    caveDrawn = null;
    renderFloorChips(area);
    if (!area) return;
    const m = caveMapOf(area);
    const w = m.gx1 - m.gx0 + 1 + 2 * CAVE_PAD;
    const h = m.gz1 - m.gz0 + 1 + 2 * CAVE_PAD;
    const px = Math.max(3, Math.min(10, Math.floor(2400 / Math.max(w, h)))); // canvas pixels per 2 m cell
    const canvas = () => Object.assign(document.createElement('canvas'), { width: w * px, height: h * px });
    const c = m.cell;
    const bounds = [[(m.gz0 - CAVE_PAD) * c - c / 2, (m.gx0 - CAVE_PAD) * c - c / 2], [(m.gz1 + CAVE_PAD) * c + c / 2, (m.gx1 + CAVE_PAD) * c + c / 2]];
    const seenCanvas = canvas();
    const unseenCanvas = canvas();
    caveDrawn = {
      area, m, px, seenCanvas, unseenCanvas,
      seen: new CanvasOverlay(seenCanvas, bounds, { pane: 'caveCells', interactive: false, className: 'cave-map' }).addTo(map),
      unseen: new CanvasOverlay(unseenCanvas, bounds, { pane: 'caveFog', interactive: false, className: 'cave-map' }).addTo(map),
    };
    paintCave();
  }
  function paintCave() {
    const d = caveDrawn;
    if (!d) return;
    d.fogOn = fogActive();
    paintCaveCanvas(d.seenCanvas, d.area, d.m, d.px, 'seen');
    paintCaveCanvas(d.unseenCanvas, d.area, d.m, d.px, 'unseen');
    map.getPane('caveFog').style.opacity = String(1 - prefs.fog / 100);
    renderCaveCount();
  }
  let cavePaintTimer = 0;
  function paintCaveSoon() { // live steps come twice a second; the cave is painted again at most every 0.4 s
    if (!cavePaintTimer) cavePaintTimer = setTimeout(() => { cavePaintTimer = 0; paintCave(); }, 400);
  }

  // The floor chips: All floors, Floor 1, Floor 2, ..., Ramps and shafts.
  function renderFloorChips(area) {
    const box = $('#cave-floors');
    const m = area ? caveMapOf(area) : null;
    box.hidden = !m || m.layers.length < 2; // what's drawn: a flat bunker has nothing to pick
    if (box.hidden) return;
    const pick = pickOf(area);
    const drawn = new Set(m.layers.map((l) => l.floor));
    const chip = (v, label, color, title) => `<button type="button" data-floor="${v}" aria-pressed="${String(pick) === String(v)}"${title ? ` title="${title}"` : ''}>${color ? `<i style="background:${color}"></i>` : ''}${label}</button>`;
    box.innerHTML = chip('all', 'All floors')
      + m.floors.map((f, i) => (drawn.has(i) ? chip(i, `Floor ${i + 1}`, FLOOR_COLORS[i], `At about ${Math.round(f.h)} m`) : '')).join('')
      + (drawn.has(-1) ? chip('ramps', 'Ramps and shafts', RAMP_COLOR) : '');
  }
  // A cave or bunker opens on all its floors, and stays there: the map doesn't switch floors as you climb.
  function setCaveFloor(pick) {
    if (!cave || (caveFloor.area === cave.id && caveFloor.pick === pick)) return;
    caveFloor = { area: cave.id, pick };
    renderFloorChips(cave);
    paintCave();
    for (const l of LOCS) if (l.a === cave.id) paintMarker(l.id);
  }
  $('#cave-floors').addEventListener('click', (e) => {
    const v = e.target.closest('[data-floor]')?.dataset.floor;
    if (v != null) setCaveFloor(v === 'all' || v === 'ramps' ? v : Number(v));
  });
  // An item in a cave is on the floor of the outline cell nearest to it.
  const locFloor = new Map();
  function otherFloor(l) {
    if (!cave || l.a !== cave.id) return false;
    const pick = pickOf(cave);
    if (pick === 'all') return false;
    if (!locFloor.has(l.id)) {
      const m = caveMapOf(AREA[l.a]);
      const gx = Math.round(l.x / m.cell);
      const gz = Math.round(l.y / m.cell);
      let best = Infinity;
      let floor = -1;
      for (let dx = -6; dx <= 6; dx++) {
        for (let dz = -6; dz <= 6; dz++) {
          for (const k of m.at.get(m.key(gx + dx, gz + dz)) || []) {
            if (dx * dx + dz * dz < best) { best = dx * dx + dz * dz; floor = m.floorOf[k]; }
          }
        }
      }
      locFloor.set(l.id, floor);
    }
    const f = locFloor.get(l.id);
    return (f < 0 ? 'ramps' : f) !== pick;
  }
  // The scale bar (a round length, 10 m when it fits) and north, at the bottom of the cave view.
  function renderCaveLegend() {
    if (!cave) return;
    const perM = Math.abs(map.latLngToContainerPoint([0, 10]).x - map.latLngToContainerPoint([0, 0]).x) / 10;
    const len = [10, 20, 50, 100, 200, 500].find((v) => v * perM >= 36) || 500;
    const el = $('#cave-legend');
    el.querySelector('i').style.width = `${Math.round(len * perM)}px`;
    el.querySelector('em').textContent = `${len} m`;
  }
  map.on('zoomend', renderCaveLegend);

  function caveExplored(area) {
    const bits = underBits(area.id);
    let n = 0;
    if (bits) for (let k = 0; k < area.cells.length; k++) n += hasCell(bits, k);
    const pct = area.cells.length ? (n * 100) / area.cells.length : 0;
    return pct > 0 && pct < 1 ? pct.toFixed(1) : Math.round(pct);
  }
  function renderCaveCount() {
    if (!cave) return;
    const here = LOCS.filter((l) => l.a === cave.id);
    const where = cave.kind === 'cave' ? ' in this cave' : ' in this bunker';
    $('#cave-count').textContent = exploring()
      ? `${here.filter((l) => store.found.has(l.id)).length} of ${here.length} found${where} · Explored ${caveExplored(cave)}%`
      : `${here.length} item${here.length === 1 ? '' : 's'}${where}`;
  }
  function underSets(world) {
    if (!store.exploredUnder.has(world)) store.exploredUnder.set(world, new Map());
    return store.exploredUnder.get(world);
  }
  // Cells just seen in a cave (live): the one on screen is painted again.
  function addExploredUnder(world, id, cells) {
    const area = AREA[id];
    if (!area) return;
    const sets = underSets(world);
    if (!sets.has(id)) sets.set(id, new Uint8Array((area.cells.length + 7) >> 3));
    const bits = sets.get(id);
    for (const k of cells) bits[k >> 3] |= 1 << (k & 7);
    if (world === store.view) uncoverSoon();
    if (world !== store.view || caveDrawn?.area.id !== id) return;
    paintCaveSoon();
    if (!fogMenu.hidden) renderFogMenu();
  }

  // ---------- what's under the fog (Explore) ----------
  // Clearing the fog shows everything there, as not found yet (only what you carry counts as found). On the
  // island a spot shows once its 10 m cell is clear, gaps the fog joins up included, so what looks clear is
  // clear; underground, once an outline cell on its floor within 3 m of it is, in that cave's own fog.
  // Walking over a cave doesn't uncover what's in it. The fog brush and a fog reset work the same way:
  // paint the fog back and what's under it hides again. Locked spots show as locks (see "Explore and Guide").
  const UNCOVER_REACH = 3;
  const coverCells = new Map(); // loc id -> the outline cells around it on its floor, worked out once
  function caveCellsAround(l) {
    if (!coverCells.has(l.id)) {
      const floor = floorHeight(l);
      const out = [];
      AREA[l.a].cells.forEach(([x, z, y], k) => {
        if (Math.hypot(x - l.x, z - l.y) <= UNCOVER_REACH && (floor == null || Math.abs(y - floor) <= 6)) out.push(k);
      });
      coverCells.set(l.id, out);
    }
    return coverCells.get(l.id);
  }
  function clearAt(x, z) { // the island's fog is gone here
    if (!fogBits) return false;
    fogJoined ||= joinedCells(fogBits);
    const i = Math.floor((x - GRID.min) / GRID.cell);
    const j = Math.floor((z - GRID.min) / GRID.cell);
    return i >= 0 && j >= 0 && i < GRID.size && j < GRID.size && !!fogJoined[j * GRID.size + i];
  }
  function isUncovered(l) {
    if (isUnderground(l)) {
      const bits = AREA[l.a] ? underBits(l.a) : null;
      return !!bits && caveCellsAround(l).some((k) => hasCell(bits, k));
    }
    return clearAt(l.x, l.y);
  }
  let uncoverTimer = 0;
  function updateUncovered() {
    clearTimeout(uncoverTimer);
    uncoverTimer = 0;
    const next = new Set(LOCS.filter(isUncovered).map((l) => l.id));
    const changed = [...next].filter((id) => !uncovered.has(id)).concat([...uncovered].filter((id) => !next.has(id)));
    uncovered = next;
    if (changed.length) refreshKnown(changed);
    drawClimbs();
  }
  function uncoverSoon() { // cells come in as you walk: look again at most every half second
    if (!uncoverTimer) uncoverTimer = setTimeout(updateUncovered, 500);
  }
  function fogChanged() { // the island cells of the world on screen changed
    fogJoined = null;
    uncoverSoon();
  }

  // ---------- climbing ropes and ladders ----------
  // From the game's scene files (data/climbs.js): a cave's climbing ropes and a bunker's hatch ladder on its
  // map, the ropes up the island's cliffs on the island. They show on every floor (they go between them), and
  // in Explore once their fog is gone, like everything else: underground, any outline cell within 3 m of
  // the rope, at any height, since you see a rope from the top or the bottom.
  const CLIMBS = window.SOTF_CLIMBS || [];
  const CLIMB_LOOK = {
    rope: { name: 'Climbing rope', svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="4.5" r="2"/><path d="M12 6.5c-3 2.5 3 4 0 6.5s3 4 0 6.5V22"/></svg>' },
    ladder: { name: 'Ladder', svg: '<svg viewBox="0 0 24 24"><path d="M7.5 2v20M16.5 2v20M7.5 6.5h9M7.5 12h9M7.5 17.5h9"/></svg>' },
  };
  const climbLayer = L.layerGroup().addTo(map);
  const climbCells = new Map(); // climb -> the outline cells around it, worked out once
  let climbsDrawn = null;
  function climbShown(c) {
    if ((c.a || null) !== (cave?.id || null)) return false; // a cave's on its map, the island's on the island
    if (!exploring()) return true;
    if (!c.a) return clearAt(c.x, c.y);
    const bits = underBits(c.a);
    if (!bits || !AREA[c.a]) return false;
    if (!climbCells.has(c)) {
      climbCells.set(c, AREA[c.a].cells.flatMap(([x, z], k) => (Math.hypot(x - c.x, z - c.y) <= UNCOVER_REACH ? [k] : [])));
    }
    return climbCells.get(c).some((k) => hasCell(bits, k));
  }
  function drawClimbs() {
    const shown = CLIMBS.filter(climbShown);
    const sig = shown.map((c) => CLIMBS.indexOf(c)).join(',');
    if (sig === climbsDrawn) return;
    climbsDrawn = sig;
    climbLayer.clearLayers();
    for (const c of shown) {
      const look = CLIMB_LOOK[c.k];
      const icon = L.divIcon({ className: `climb climb-${c.k}`, html: `<span class="pin-dot">${look.svg}</span>`, iconSize: [0, 0] });
      const title = `${look.name} · the top is at about ${Math.round(c.h)} m`;
      L.marker([c.y, c.x], { icon, title, alt: look.name, keyboard: false, zIndexOffset: 300 }).addTo(climbLayer);
    }
  }

  // The game's AreaMask bits (Sons.Areas.AreaMask): caves A-H and the seven bunkers.
  const AREA_CAVES = 478;
  const AREA_BUNKERS = 8257568;

  // Which cave or bunker is at this spot? Counts outline cells nearby at about the same height.
  function areaAt(x, z, h, { reach = 6, dy = 25, need = 2, kind = null } = {}) {
    let best = null;
    let score = 0;
    for (const a of AREAS) {
      if (kind && a.kind !== kind) continue;
      const [x0, z0, x1, z1] = a.bounds;
      if (x < x0 - 20 || x > x1 + 20 || z < z0 - 20 || z > z1 + 20) continue;
      const cx = Math.round(x / a.cell);
      const cz = Math.round(z / a.cell);
      let n = 0;
      for (let dx = -reach; dx <= reach; dx++) {
        for (let dz = -reach; dz <= reach; dz++) {
          const y = a.lookup.get(`${cx + dx},${cz + dz}`);
          if (y !== undefined && (h == null || Math.abs(y - h) < dy)) n++;
        }
      }
      if (n > score) { best = a; score = n; }
    }
    return score >= need ? best : null;
  }

  function updateCave() {
    const pos = store.position;
    const live = pos && pos.source === 'live' && Date.now() / 1000 - pos.time < 20;
    // The mod sends the game's own cave flag and area mask (the mask also says cave or bunker). Older
    // feeds don't: then only a spot right among a cave's cells at almost the same height counts, so
    // walking over a cave on the surface doesn't.
    const mask = pos?.area || 0;
    const kind = mask & AREA_BUNKERS ? 'bunker' : mask & AREA_CAVES ? 'cave' : null;
    const flagged = pos?.cave === undefined && pos?.area === undefined ? undefined : !!pos.cave || !!kind;
    const underground = live && (flagged ?? !!areaAt(pos.x, pos.y, pos.h, { reach: 3, dy: 6, need: 3 }));
    const here = underground ? areaAt(pos.x, pos.y, pos.h, { kind }) || areaAt(pos.x, pos.y, pos.h) || (cave && !cave.manual ? cave : null) : null;
    if (!here) caveDismissed = null;
    if (cave?.manual) return; // browsing a cave by hand: leave it until the user goes back
    const want = here && here.id !== caveDismissed ? here : null;
    if (want?.id !== cave?.id) showArea(want);
  }

  function showArea(area, { manual = false } = {}) {
    if (area) closeBrush(); // the brush paints the island's fog
    cave = area ? Object.assign(Object.create(area), { manual }) : null;
    caveLayer.clearLayers();
    document.body.classList.toggle('cave-mode', !!area);
    const banner = $('#cave-banner');
    if (area) {
      L.rectangle([[-3000, -3000], [3000, 3000]], {
        pane: 'caveVeil', stroke: false, fillColor: '#07090a', fillOpacity: 0.88, interactive: false,
      }).addTo(caveLayer);
      $('#cave-name').textContent = area.name;
      banner.hidden = false;
      const [x0, z0, x1, z1] = area.bounds;
      if (following && store.position) map.panTo([store.position.y, store.position.x]);
      else map.flyToBounds([[z0, x0], [z1, x1]], { padding: [40, 40], duration: 0.6, maxZoom: 2 });
    } else {
      banner.hidden = true;
    }
    if (!area || caveFloor.area !== area.id) caveFloor = { area: null, pick: 'all' };
    drawCaveCells(cave);
    renderCaveLegend();
    applyFilters();
    drawTrail();
    updateStatus();
  }

  // ---------- your camps and parked vehicles (read from your latest save) ----------
  const campLayer = L.layerGroup().addTo(map);
  const CAMP_ICON = '<svg viewBox="0 0 24 24"><path d="M3 20h18M5.5 20 12 7l6.5 13M12 7l-1.5-3M12 7l1.5-3M10 20l2-4 2 4"/></svg>';
  const VEHICLES = {
    cart: { i: 'golf-cart', t: 'Golf Cart', base: 910000 },
    glider: { i: 'hang-glider', t: 'Hang Glider', base: 920000 },
    knightv: { i: 'knightv', t: 'Knight V', base: 930000 },
  };

  // Gliders you put down yourself (a glider folds up into your inventory): where you left them at your last
  // save. They're yours, so Explore shows them too.
  const gliderLayer = L.layerGroup().addTo(map);
  const myGliders = () => (store.world?.vehicles || []).filter((v) => v.mine);
  function applyWorld(w) {
    store.world = w;
    campLayer.clearLayers();
    gliderLayer.clearLayers();
    myGliders().forEach((g, i) => {
      const m = L.marker([g.y, g.x], {
        icon: L.divIcon({ className: 'loc my-glider', html: `<span class="pin-dot" style="--c:${CAT.vehicle.color}"><img src="icons/hang-glider.webp" alt=""></span>`, iconSize: [0, 0] }),
        title: 'Your glider', alt: 'Your glider', zIndexOffset: 450,
      });
      tapToSelect(m, () => select({ kind: 'glider', id: i }));
      gliderLayer.addLayer(m);
    });
    (w?.camps || []).forEach((c, i) => {
      const m = L.marker([c.y, c.x], {
        icon: L.divIcon({ className: 'loc camp-pin', html: `<span class="pin-dot">${CAMP_ICON}</span>`, iconSize: [0, 0] }),
        title: 'Your camp', alt: 'Your camp', zIndexOffset: 400,
      });
      tapToSelect(m, () => select({ kind: 'camp', id: i }));
      campLayer.addLayer(m);
    });
    const byVehicle = new Map(LOCS.filter((l) => l.v).map((l) => [l.v, l]));
    for (const v of w?.vehicles || []) {
      if (v.mine) continue; // drawn above
      let l = byVehicle.get(v.id);
      if (!l) { // a vehicle the source map has no pin for: add one
        const kind = VEHICLES[v.k];
        if (!kind) continue;
        const num = Number(v.id.split('.').pop());
        l = { id: kind.base + num, c: 'vehicle', i: kind.i, t: `${kind.t} ${String(num).padStart(2, '0')}`, x: v.x, y: v.y, v: v.id };
        LOCS.push(l);
        BY_ID.set(l.id, l);
        createMarker(l);
      }
      if (l.x0 === undefined) { l.x0 = l.x; l.y0 = l.y; }
      l.x = v.x;
      l.y = v.y;
      l.h = v.h;
      l.parked = { moved: Math.hypot(v.x - l.x0, v.y - l.y0) > 8, time: w.time };
      markers.get(l.id)?.setLatLng([l.y, l.x]);
    }
    applyFilters();
    renderSidebar();
    if (selected) renderDetail();
  }

  function renderMyGlider(g) {
    detail.innerHTML = cardHtml({
      icon: `<span class="ico" style="--c:${CAT.vehicle.color}"><img src="icons/hang-glider.webp" alt=""></span>`,
      title: 'Your glider', kind: 'Where you put it down · from your last save',
      peek: distanceLine(g.x, g.y),
      details: `<div class="meta"><span>X ${Math.round(g.x)} · Z ${Math.round(g.y)}</span></div>`,
      actions: `${guideButton(`glider:${Math.round(g.x)},${Math.round(g.y)}`)}<button class="secondary" data-act="close">Done</button>`,
    });
  }

  function renderCamp(c) {
    const items = (c.items || []).map((i) => `<li><span>${esc(i.n)}</span><span class="done">×${i.c}</span></li>`).join('');
    detail.innerHTML = cardHtml({
      icon: `<span class="ico" style="--c:#b9773a">${CAMP_ICON}</span>`,
      title: 'Your camp', kind: `${c.pieces} building pieces · from your last save`,
      peek: distanceLine(c.x, c.y),
      details: `
        ${c.logs ? `<p>${c.logs} log building piece${c.logs === 1 ? '' : 's'}${items ? ', and:' : ''}</p>` : ''}
        ${items ? `<ul class="camp-items">${items}</ul>` : ''}
        <div class="meta"><span>X ${Math.round(c.x)} · Z ${Math.round(c.y)}</span></div>`,
      actions: `${guideButton(`camp:${Math.round(c.x)},${Math.round(c.y)}`)}<button class="secondary" data-act="close">Done</button>`,
    });
  }

  $('#cave-exit').onclick = () => {
    if (!cave) return;
    if (!cave.manual) caveDismissed = cave.id;
    showArea(null);
    if (store.position) flyTo([store.position.y, store.position.x], Math.min(map.getZoom(), 0), { duration: 0.6 });
  };

  let autoSavedAt = 0;
  // the main entry of each bunker and cave ("BunkerFood"): visited once you've been inside
  const AREA_PLACES = {};
  for (const l of LOCS) if ((l.c === 'cave' || l.c === 'bunker') && l.g && l.a && /^(bunker|cave)/i.test(l.t)) (AREA_PLACES[l.a] ||= []).push(l);
  // Entrances and bunkers came later than the other places, so the whole trail is looked at once for them.
  const AUTO_MARK_SCAN = 2;
  function autoMark(extra = []) {
    if (!prefs.autoMark) return;
    const rescan = (prefs.autoMarkScan || 0) < AUTO_MARK_SCAN;
    const since = rescan ? 0 : prefs.autoMarkedUpTo;
    const pts = currentTrail().filter((p) => p.t > since);
    if (store.position?.source === 'live' && (!store.view || store.view === store.active)) pts.push({ ...store.position, t: store.position.time });
    pts.push(...extra);
    if (!pts.length) return;
    const fresh = rescan ? pts.filter((p) => p.t == null || p.t > prefs.autoMarkedUpTo) : pts;
    const hits = [];
    for (const l of LOCS) {
      if (!AUTO_MARK.has(l.c) || store.found.has(l.id) || l.g || l.r?.length) continue;
      const entrance = l.c === 'cave' || l.c === 'bunker';
      const from = entrance ? pts : fresh;
      const r = AUTO_RADIUS[l.c] ?? AUTO_RADIUS.other;
      if (from.some((p) => Math.hypot(p.x - l.x, p.y - l.y) <= r && sameLevel(p, l))) hits.push(l.id);
    }
    const inside = new Set(cave && !cave.manual ? [cave.id] : []);
    for (const p of pts) {
      if (!wasUnder(p)) continue;
      const a = areaAt(p.x, p.y, p.h); // older steps have no height: then the outline alone decides
      if (a) inside.add(a.id);
    }
    for (const id of inside) for (const l of AREA_PLACES[id] || []) if (!store.found.has(l.id) && !hits.includes(l.id)) hits.push(l.id);
    if (rescan && store.online && store.trail.length) prefs.autoMarkScan = AUTO_MARK_SCAN;
    prefs.autoMarkedUpTo = pts.reduce((m, p) => Math.max(m, p.t || 0), prefs.autoMarkedUpTo);
    if (hits.length || Date.now() - autoSavedAt > 15000) {
      autoSavedAt = Date.now();
      savePrefs();
    }
    if (hits.length) {
      setFound(hits, true);
      toast(hits.length === 1 ? `Marked ${nice(BY_ID.get(hits[0]).t)} as visited` : `Marked ${hits.length} places you visited`);
    }
    return hits.length;
  }

  // ---------- what your save says about where you've been ----------
  // The map app reads your newest save: the items you carry, the game's own "found" flags for some places,
  // and your zip lines. An item counts as found when it has only one spot on the map (a radio could come
  // from anywhere, the Modern Axe only from one place). Each thing is looked at once per world.
  const ITEM_SPOTS = {}; // the game's item id -> map locations with it
  for (const [loc, item] of Object.entries(window.SOTF_ITEMS || {})) (ITEM_SPOTS[item] ||= []).push(Number(loc));
  const squash = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
  function historyPoints(w) {
    const spots = (w?.history?.spots || []).map((s) => ({ ...s, s: 'spot' }));
    const camps = (w?.camps || []).map((c) => ({ x: c.x, y: c.y, h: c.h, s: 'camp' }));
    // where this world began: the crash site it started at (each playthrough picks one)
    const crash = w?.history?.crashSite && LOCS.find((l) => l.c === 'spawn' && l.t.toLowerCase().startsWith(w.history.crashSite));
    return [...spots, ...camps, ...(crash ? [{ x: crash.x, y: crash.y, s: 'start' }] : [])];
  }
  // Everything you changed in the world, from all your saves of it: trees you felled, bushes you picked,
  // crates you opened, things you broke or took. Each spot comes with the time of the save it first shows up
  // in, so a new save only brings what's new. Points in a cave or bunker are marked as underground.
  const changedCache = new WeakMap();
  function changedPoints(w) {
    const groups = w?.history?.changed;
    if (!groups?.length) return [];
    let pts = changedCache.get(groups);
    if (pts) return pts;
    pts = [];
    for (const g of groups) {
      for (let i = 0; i + 2 < g.p.length; i += 3) {
        const [x, y, h] = [g.p[i], g.p[i + 1], g.p[i + 2]];
        pts.push({ x, y, h, t: g.t, s: 'changed', cave: !!areaAt(x, y, h, { reach: 3, dy: 6, need: 3 }) });
      }
    }
    changedCache.set(groups, pts);
    return pts;
  }
  // Items you carry that were right where you changed something (within 5 m, on the same level). Walking
  // past an item isn't taking it, so only what's in your inventory counts: taken when it's the only one of
  // its spots with a change, "probably found here" (the closest) when several have one. Items you don't carry
  // (and crates, which have no item to carry) are never marked from this. Places are left to autoMark (being
  // being right at one is a visit) and locked spots to the encounters. A glider counts like any item: you can carry one.
  const CHANGED_NEAR = 5;
  function changedMatches(changed, carried) {
    const found = [];
    const probable = [];
    if (!changed.length) return { found, probable };
    const grid = new Map(); // 10 m cells, so a thousand locations against thousands of points stays quick
    for (const p of changed) {
      const k = `${Math.floor(p.x / 10)},${Math.floor(p.y / 10)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    }
    const closest = (l) => {
      let best = Infinity;
      const cx = Math.floor(l.x / 10);
      const cy = Math.floor(l.y / 10);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const p of grid.get(`${cx + dx},${cy + dy}`) || []) {
            const d = Math.hypot(p.x - l.x, p.y - l.y);
            if (d <= CHANGED_NEAR && d < best && sameLevel(p, l)) best = d;
          }
        }
      }
      return best;
    };
    const byItem = new Map();
    for (const l of LOCS) {
      if (AUTO_MARK.has(l.c) || needsOf(l).length) continue;
      const item = (window.SOTF_ITEMS || {})[l.id];
      if (item == null || !carried.has(item)) continue;
      if (store.found.has(l.id) || store.probable.has(l.id) || store.dismissed.has(l.id)) continue;
      const d = closest(l);
      if (d === Infinity) continue;
      if (!byItem.has(item)) byItem.set(item, []);
      byItem.get(item).push({ id: l.id, d });
    }
    for (const [item, spots] of byItem) {
      if (ITEM_SPOTS[item].some((id) => store.found.has(id) || store.probable.has(id))) continue; // one is marked already
      spots.sort((a, b) => a.d - b.d);
      (spots.length === 1 ? found : probable).push(spots[0].id);
    }
    return { found, probable };
  }
  function applyHistory() {
    const w = store.worlds.get(store.view);
    if (!w || !store.online || !prefs.autoMark) return;
    const all = (prefs.historySeen ||= {});
    const seen = new Set(all[w.uid] || []);
    const fresh = (k) => !seen.has(k) && !!seen.add(k);
    const ids = [];
    for (const item of w.history?.items || []) {
      const spots = ITEM_SPOTS[item];
      if (fresh(`item:${item}`) && spots?.length === 1 && !store.found.has(spots[0])) ids.push(spots[0]);
    }
    for (const name of w.history?.pois || []) {
      const l = fresh(`poi:${name}`) && LOCS.find((x) => squash(x.t) === squash(name));
      if (l && !store.found.has(l.id) && !ids.includes(l.id)) ids.push(l.id);
    }
    const pts = historyPoints(w).filter((p) => fresh(`${p.s}:${Math.round(p.x)},${Math.round(p.y)}`));
    // what you changed since this device last looked
    const upTo = (prefs.changedUpTo ||= {});
    const changed = changedPoints(w).filter((p) => p.t > (upTo[w.uid] || 0));
    if (changed.length) upTo[w.uid] = changed.reduce((m, p) => Math.max(m, p.t), 0);
    const right = changedMatches(changed, new Set(w.history?.items || []));
    for (const id of right.found) if (!ids.includes(id)) ids.push(id);
    const near = [...right.probable];
    const marked = (id) => ids.includes(id) || near.includes(id) || store.found.has(id) || store.probable.has(id);
    const unplaced = [];
    // An item you carry that's in several places (a Cooking Pot has 10) with no change right at one of them:
    // the spot nearest to where you've been is probably where it came from. It shows as "probably found
    // here", for you to confirm or not.
    for (const item of w.history?.items || []) {
      const spots = ITEM_SPOTS[item];
      if (!spots || spots.length < 2 || !fresh(`near:${item}`)) continue;
      if (spots.some(marked)) continue; // one of them is marked already
      const best = nearestSpot(spots, w);
      if (best != null) near.push(best);
      else unplaced.push(spots[0]);
    }
    all[w.uid] = [...seen];
    savePrefs();
    if (ids.length) setFound(ids, true);
    // where you changed something, you were: places nearby count as visited, locked spots as come across
    const been = [...pts, ...changed.map(({ x, y, h, cave }) => ({ x, y, h, cave }))]; // a save's time isn't when you were there
    const visited = been.length ? autoMark(been) || 0 : 0;
    if (been.length) noteEncounters(been);
    if (near.length) {
      near.forEach((id) => store.probable.add(id));
      persistMarks('probable', near);
      refreshKnown(near);
    }
    const what = unplaced.map((id) => `a ${nice(BY_ID.get(id).t).replace(/\s*\d+$/, '')}`).join(' and ');
    const unsure = unplaced.length ? `you carry ${what} but not from where: search for it, open the one you took and tap "It came from here"` : '';
    if (!ids.length && !near.length && !unsure) return; // autoMark said what it marked, if anything
    const names = ids.map((id) => nice(BY_ID.get(id).t));
    const found = names.length ? `${names.length <= 2 ? names.join(' and ') : names.length + ' things'} marked found` : '';
    const places = visited ? `${visited} place${visited === 1 ? '' : 's'} visited` : '';
    const guessed = near.length ? `${near.length} more probably found near where you've been` : '';
    toast(`From your save: ${[found, places, guessed, unsure].filter(Boolean).join('; ')}`, { ms: unsure ? 12000 : 2800 });
  }
  // the spot (of these) nearest to your trail, saves, camps and zip lines, within 150 m and on the same level
  function nearestSpot(spots, w) {
    const been = [...currentTrail(), ...historyPoints(w), ...changedPoints(w)];
    let best = null;
    let bestD = 150;
    for (const id of spots) {
      const l = BY_ID.get(id);
      if (!l || store.dismissed.has(id)) continue;
      for (const p of been) {
        const d = Math.hypot(p.x - l.x, p.y - l.y);
        if (d < bestD && sameLevel(p, l)) { best = id; bestD = d; }
      }
    }
    return best;
  }
  // An item you carry that has several spots, none of them marked: the save doesn't say which one it came
  // from (for a glider it never does: the island's gliders stay listed where they start). Its cards ask you.
  function carriedUnplaced(l) {
    const item = (window.SOTF_ITEMS || {})[l.id];
    const spots = item != null ? ITEM_SPOTS[item] : null;
    if (!spots || spots.length < 2 || store.found.has(l.id)) return false;
    if (!(store.worlds.get(store.view)?.history?.items || []).includes(item)) return false;
    return !spots.some((id) => store.found.has(id) || store.probable.has(id));
  }
  function confirmProbable(id, here) {
    store.probable.delete(id);
    persistMarks('probable', [id], false);
    if (here) return setFound([id], true);
    // not from here: remember that, and try the next nearest spot of the same item
    store.dismissed.add(id);
    persistMarks('dismissed', [id]);
    const item = (window.SOTF_ITEMS || {})[id];
    const next = item != null ? nearestSpot(ITEM_SPOTS[item], store.worlds.get(store.view)) : null;
    if (next != null) {
      store.probable.add(next);
      persistMarks('probable', [next]);
      toast(`Maybe this one, then: ${nice(BY_ID.get(next).t)} ${distanceTextPlain(BY_ID.get(next))}`);
    }
    refreshKnown(next != null ? [id, next] : [id]);
    renderDetail();
  }
  function distanceTextPlain(l) {
    const pos = store.position;
    if (!pos) return '';
    return `(${fmtDist(Math.hypot(l.x - pos.x, l.y - pos.y))} ${compass(l.x - pos.x, l.y - pos.y)})`;
  }

  // ---------- found ----------
  function setFound(ids, found) {
    for (const id of ids) found ? store.found.add(id) : store.found.delete(id);
    ids.forEach(paintMarker);
    LOCKS.forEach((l) => paintMarker(l.id)); // what they need may have changed
    applyFilters();
    renderSidebar();
    if (selected) renderDetail();
    persist('found', { ids, found });
    if (!found) return;
    for (const id of ids) {
      const spots = openedBy(id).filter((l) => lockState(l) === 'open');
      if (!spots.length) continue;
      const n = BY_ID.get(id);
      toast(`${nice(n.t)} found: ${spots.length} locked spot${spots.length === 1 ? '' : 's'} you've seen can be opened`,
        { action: 'Go back', ms: 9000, onAction: () => select({ kind: 'unlocks', id }) });
      break;
    }
  }
  // the locked spots you've seen that this item is needed for (and that you haven't done yet)
  const openedBy = (id) => LOCKS.filter((l) => store.encountered.has(l.id) && !store.found.has(l.id) && l.r.includes(id));

  // ---------- selection + detail card ----------
  let selected = null;
  const detail = $('#detail');

  function select(sel, { fly = false } = {}) {
    collapseSpread();
    const prev = selected;
    selected = sel;
    if (prev?.kind === 'loc') paintMarker(prev.id);
    let target = null;
    if (sel.kind === 'loc') {
      applyFilters();
      paintMarker(sel.id);
      markers.forEach((m, id) => m.setZIndexOffset(id === sel.id ? 1000 : 0));
      const l = BY_ID.get(sel.id);
      target = [l.y, l.x];
    } else if (sel.kind === 'camp') {
      const c = store.world?.camps?.[sel.id];
      if (c) target = [c.y, c.x];
    } else if (sel.kind === 'glider') {
      const g = myGliders()[sel.id];
      if (g) target = [g.y, g.x];
    } else if (sel.kind === 'unlocks') {
      const spots = openedBy(sel.id);
      if (spots.length) map.flyToBounds(L.latLngBounds(spots.map((l) => [l.y, l.x])).pad(0.3), { maxZoom: 1, duration: 0.6 });
    } else {
      drawPins();
      const p = store.pins.find((x) => x.id === sel.id);
      if (p) target = [p.y, p.x];
    }
    if (prev?.kind === 'pin' && sel.kind !== 'pin') drawPins();
    openLists.clear();
    openNeeds.clear();
    setExpanded(!!sel.fresh, { quiet: true }); // a new pin opens with its name field; everything else as a peek
    renderDetail();
    detail.hidden = false;
    placeCard();
    selectedAt = target;
    if (target) bringIntoView(target, fly);
    if (sel.fresh) detail.querySelector('#pin-label')?.focus();
  }

  // On phones the card covers the bottom of the map, so the selection goes to the middle of the part above it.
  const phoneLayout = window.matchMedia('(max-width: 820px)');
  let selectedAt = null;
  function bringIntoView(ll, fly) {
    if (following) {
      if (!fly) return; // the map stays on you
      setFollowing(false);
    }
    const size = map.getSize();
    const sheet = phoneLayout.matches && !detail.hidden ? Math.min(detail.offsetHeight, size.y * 0.6) : 0;
    const top = 64; // the top bar
    const y = sheet ? Math.max(top + 40, (size.y - sheet + top) / 2) : size.y / 2;
    if (fly) {
      const z = Math.max(map.getZoom(), 0.5);
      flyTo(map.unproject(map.project(ll, z).add([0, size.y / 2 - y]), z), z, { duration: 0.6 });
    } else if (sheet) {
      const p = map.latLngToContainerPoint(ll);
      if (p.y > size.y - sheet - 24 || p.y < top + 16) map.panBy([0, p.y - y]);
    }
  }

  // ---------- the card as a sheet on phones: a peek with the two main actions, or expanded with details ----------
  let expanded = false;
  const openLists = new Set(); // lists where "Show all" was tapped
  function setExpanded(on, { quiet = false } = {}) {
    expanded = on;
    detail.classList.toggle('expanded', on);
    const more = detail.querySelector('.more-row');
    if (more) {
      more.textContent = on ? 'Fewer details' : 'More details';
      more.setAttribute('aria-expanded', on);
    }
    if (!quiet && !on && selectedAt && phoneLayout.matches) bringIntoView(selectedAt, false);
  }

  function cardHtml({ icon, title, kind, peek = '', details = '', actions }) {
    return `
      <div class="grab" aria-hidden="true"></div>
      <div class="card-head">
        ${icon}
        <div><h2>${esc(title)}</h2><div class="kind">${esc(kind)}</div></div>
        <button class="icon-btn" data-act="close" aria-label="Close">&times;</button>
      </div>
      <div class="card-scroll">
        ${peek ? `<div class="card-peek">${peek}</div>` : ''}
        ${details ? `<button class="more-row" data-act="more" aria-expanded="${expanded}">${expanded ? 'Fewer details' : 'More details'}</button>
        <div class="card-details">${details}</div>` : ''}
      </div>
      <div class="card-main">${actions}</div>`;
  }
  function distanceLine(x, y) {
    const d = distanceText(x, y);
    return d ? `<div class="dist-line">${d}</div>` : '';
  }

  // Swipe the handle or the title: up for details, down for the peek (or to close it).
  let drag = null;
  detail.addEventListener('pointerdown', (e) => {
    if (!phoneLayout.matches || !e.target.closest('.grab, .card-head') || e.target.closest('button')) return;
    drag = { y: e.clientY, id: e.pointerId, dy: 0, onGrab: !!e.target.closest('.grab') };
    try { detail.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
  });
  detail.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dy = e.clientY - drag.y;
    detail.style.transform = `translateY(${drag.dy > 0 ? drag.dy : drag.dy / 4}px)`;
  });
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { dy, onGrab } = drag;
    drag = null;
    detail.style.transform = '';
    if (Math.abs(dy) < 8) { if (onGrab) setExpanded(!expanded); return; } // a tap on the handle
    if (dy < -40) setExpanded(true);
    else if (dy > 60) expanded ? setExpanded(false) : closeDetail();
  }
  detail.addEventListener('pointerup', endDrag);
  detail.addEventListener('pointercancel', endDrag);

  // tap a screenshot to see it full screen
  const shotView = $('#shot-view');
  shotView.onclick = () => { shotView.hidden = true; };

  // Live updates refresh the open card (its distances) every few seconds, never while you type in it.
  let detailShownAt = 0;
  function refreshDetail() {
    const typing = detail.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (!selected || typing || drag || performance.now() - detailShownAt < 2000) return;
    renderDetail();
  }

  // On a PC a pin's card (name, type, Delete, Done) sits right next to the pin and follows it.
  function placeCard() {
    detail.classList.remove('beside');
    detail.style.left = detail.style.top = '';
    if (phoneLayout.matches || selected?.kind !== 'pin' || detail.hidden) return;
    const p = store.pins.find((x) => x.id === selected.id);
    if (!p) return;
    const pt = map.latLngToContainerPoint([p.y, p.x]);
    const box = mapEl.getBoundingClientRect();
    const w = detail.offsetWidth;
    const h = detail.offsetHeight;
    let x = box.left + pt.x + 28;
    if (x + w > innerWidth - 12) x = box.left + pt.x - 28 - w; // no room on the right: the left side
    const y = Math.max(12, Math.min(box.top + pt.y - 48, innerHeight - h - 12));
    detail.classList.add('beside');
    detail.style.left = `${Math.max(12, x)}px`;
    detail.style.top = `${y}px`;
  }
  map.on('move zoom zoomend resize', () => { if (selected?.kind === 'pin') placeCard(); });

  function closeDetail() {
    const prev = selected;
    selected = null;
    selectedAt = null;
    detail.hidden = true;
    placeCard();
    if (prev?.kind === 'loc') { paintMarker(prev.id); applyFilters(); }
    if (prev?.kind === 'pin') drawPins();
  }

  function renderDetail() {
    if (!selected) return;
    detailShownAt = performance.now();
    const scroll = detail.querySelector('.card-scroll')?.scrollTop || 0;
    paintDetail();
    const box = detail.querySelector('.card-scroll');
    if (box) box.scrollTop = scroll;
    if (!detail.hidden) placeCard();
  }
  function paintDetail() {
    if (selected.kind === 'loc') return renderLocation(BY_ID.get(selected.id));
    if (selected.kind === 'unlocks') return renderUnlocks(selected.id);
    if (selected.kind === 'camp') {
      const c = store.world?.camps?.[selected.id];
      return c ? renderCamp(c) : closeDetail();
    }
    if (selected.kind === 'glider') {
      const g = myGliders()[selected.id];
      return g ? renderMyGlider(g) : closeDetail();
    }
    const p = store.pins.find((x) => x.id === selected.id);
    if (!p) return closeDetail();
    renderPin(p);
  }

  // On phones a long list shows its first 3 and "Show all".
  function clipList(title, count) {
    const clip = count > 3 && !openLists.has(title);
    return { cls: clip ? ' clip' : '', more: clip ? `<button class="show-all" data-act="show-all" data-list="${esc(title)}">Show all ${count}</button>` : '' };
  }
  function linkList(title, list) {
    if (!list.length) return '';
    const { cls, more } = clipList(title, list.length);
    return `<div class="links${cls}"><h3>${title}</h3><ul>${list.map((l) => `
      <li><button data-go="${l.id}"><span class="ico" style="--c:${CAT[l.c].color}"><img src="icons/${l.i}.webp" alt=""></span>
      <span>${esc(nameOf(l))}</span>${store.found.has(l.id) ? '<span class="done">✓ found</span>' : ''}</button></li>`).join('')}</ul>${more}</div>`;
  }

  // "You need": each item, where it is (in Explore a spoiler, behind a red button) and what it needs in turn.
  // Tapping one never jumps there by itself: it opens a row with the button.
  const openNeeds = new Set();
  function whereIs(n) {
    const area = n.a && AREA[n.a] ? `in ${AREA[n.a].name}` : 'on the island';
    const pos = store.position;
    if (!pos) return area;
    const d = Math.hypot(n.x - pos.x, n.y - pos.y);
    return d < 15 ? `${area} · right here` : `${area} · ${fmtDist(d)} ${compass(n.x - pos.x, n.y - pos.y)}`;
  }
  function needChain(n, seen = new Set([n.id])) {
    const next = needsOf(n).filter((x) => !seen.has(x.id));
    next.forEach((x) => seen.add(x.id));
    return next.map((x) => {
      const deeper = needChain(x, seen);
      return `needs ${esc(nice(x.t))}${store.found.has(x.id) ? ' ✓' : ''}${deeper ? ' ← ' + deeper : ''}`;
    }).join(', ');
  }
  function revealRow(n) {
    if (store.found.has(n.id) || store.revealed.has(n.id)) {
      return `<div class="reveal-row"><span>${esc(whereIs(n))}</span><button class="mini" data-act="go-need" data-id="${n.id}">Show on the map</button></div>`;
    }
    if (!exploring()) {
      return `<div class="reveal-row"><span>${esc(whereIs(n))}</span><button class="mini" data-act="go-need" data-id="${n.id}">Show location</button></div>`;
    }
    return `<div class="reveal-row spoiler"><span>Reveals where it is.</span>
      <button class="danger-btn" data-act="go-need" data-id="${n.id}" data-reveal="1">Show location (spoiler)</button></div>`;
  }
  function needRows(needs) {
    return needs.map((n) => {
      const have = store.found.has(n.id);
      const where = have || store.revealed.has(n.id) || !exploring() ? `<span class="sub">${esc(whereIs(n))}</span>` : '';
      const chain = needChain(n);
      return `<li class="need${openNeeds.has(n.id) ? ' open' : ''}"><button data-act="need" data-id="${n.id}" aria-expanded="${openNeeds.has(n.id)}">
          <span class="ico" style="--c:${CAT[n.c].color}"><img src="icons/${n.i}.webp" alt=""></span>
          <span class="name">${esc(nice(n.t))}${where}${chain ? `<span class="sub chain">${chain}</span>` : ''}</span>
          ${have ? '<span class="done">✓ found</span>' : ''}</button>${openNeeds.has(n.id) ? revealRow(n) : ''}</li>`;
    }).join('');
  }
  function needList(l) {
    const needs = needsOf(l);
    return needs.length ? `<div class="links needs"><h3>You need</h3><ul>${needRows(needs)}</ul></div>` : '';
  }
  // Leaves the cave view if it's elsewhere, then shows the item (revealing it first if asked to).
  function goToNeed(id, revealIt) {
    const n = BY_ID.get(id);
    if (!n) return;
    if (revealIt) reveal([id]);
    if (cave && cave.id !== n.a) {
      if (!cave.manual) caveDismissed = cave.id;
      showArea(null);
    }
    closeDrawer();
    select({ kind: 'loc', id }, { fly: true });
  }
  // Inside a place, in Explore: what you found, and how many more there are (behind a red button).
  function insideList(l) {
    const inside = (l.n || []).map((id) => BY_ID.get(id)).filter(Boolean);
    if (!exploring()) return linkList('Inside', inside);
    const known = inside.filter(knows);
    const rest = inside.length - known.length;
    if (!rest) return linkList('Inside', known);
    const list = known.length ? linkList('Inside', known).replace(/<\/div>$/, '') : '<div class="links"><h3>Inside</h3>';
    return `${list}<p class="hidden-note">${rest} more you haven't found yet.
      <button class="text-btn danger" data-act="reveal-inside" data-id="${l.id}">Show them (spoilers)</button></p></div>`;
  }

  // ---------- ways in ----------
  // Underground items sit on the map right above where they are, so their card says where to get in.
  // Entrances are caves and bunker hatches that aren't underground themselves.
  const isEntrance = (l) => (l.c === 'cave' || l.c === 'bunker') && !l.g;
  const ENTRANCES = {};
  const CONTAINERS = {};
  for (const l of LOCS) {
    if (l.a && isEntrance(l)) (ENTRANCES[l.a] ||= []).push(l);
    for (const id of l.n || []) (CONTAINERS[id] ||= []).push(l);
  }

  function entrancesFor(l) {
    if (!l.g) return [];
    if (l.a && ENTRANCES[l.a]) return ENTRANCES[l.a];
    // A few items have no cave or bunker id: follow their "Inside" links up to an entrance.
    const seen = new Set();
    const queue = [l];
    while (queue.length) {
      for (const p of CONTAINERS[queue.shift().id] || []) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        if (isEntrance(p)) return [p];
        const viaNeeds = (p.r || []).map((id) => BY_ID.get(id)).filter((r) => r && isEntrance(r));
        if (viaNeeds.length) return viaNeeds;
        if (p.a && ENTRANCES[p.a]) return ENTRANCES[p.a];
        queue.push(p);
      }
    }
    return [];
  }

  function waysIn(l) {
    const all = entrancesFor(l);
    if (!all.length) return '';
    const list = exploring() ? all.filter(knows) : all;
    if (!list.length) {
      return `<div class="links way-in"><h3>Way in</h3><p class="hidden-note">You haven't found the way in yet.
        <button class="text-btn danger" data-act="reveal-ways" data-id="${l.id}">Show it (spoiler)</button></p></div>`;
    }
    const pos = store.position;
    const from = pos || l;
    const who = !pos ? 'from here' : pos.source === 'live' ? 'from you' : 'from your last save';
    const far = (e) => Math.hypot(e.x - from.x, e.y - from.y);
    const rows = [...list].sort((a, b) => far(a) - far(b)).map((e) => {
      const d = far(e);
      const where = d < 15 ? 'right here' : `${fmtDist(d)} ${compass(e.x - from.x, e.y - from.y)}`;
      const sub = [...new Set([e.a && AREA[e.a] ? AREA[e.a].name : '', e.d].filter(Boolean))].join(' · ');
      return `<li><button data-go="${e.id}"><span class="ico" style="--c:${CAT[e.c].color}"><img src="icons/${e.i}.webp" alt=""></span>
        <span class="name">${esc(nice(e.t))}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
        <span class="dist">${where}</span></button></li>`;
    });
    const { cls, more } = clipList('Ways in', rows.length);
    return `<div class="links way-in${cls}"><h3>${rows.length > 1 ? 'Ways in' : 'Way in'} <span>${who}</span></h3><ul>${rows.join('')}</ul>${more}</div>`;
  }

  function renderLocation(l) {
    if (hiddenLock(l)) return renderLock(l);
    const c = CAT[l.c];
    const isFound = store.found.has(l.id);
    const tags = (l.g || []).map((g) => `<span class="tag">${esc(g)}</span>`);
    if (isFound) tags.unshift('<span class="tag found">✓ Found</span>');
    const state = lockState(l);
    if (state) tags.push(`<span class="tag ${state}">${esc(lockTitle(l))}</span>`);
    const probable = store.probable.has(l.id) && !isFound;
    if (probable) tags.unshift('<span class="tag probable">Probably found here</span>');
    const links = [
      l.a && AREA[l.a] && cave?.id !== l.a ? `<button class="mini" data-act="open-area" data-area="${l.a}">${AREA[l.a].kind === 'cave' ? 'Cave' : 'Bunker'} map</button>` : '',
      l.k ? `<a class="mini" href="${esc(l.k)}" target="_blank" rel="noopener">Wiki</a>` : '',
    ].join('');
    detail.innerHTML = cardHtml({
      icon: `<span class="ico" style="--c:${c.color}"><img src="icons/${l.i}.webp" alt=""></span>`,
      title: nice(l.t), kind: c.label,
      peek: `${distanceLine(l.x, l.y)}${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}${probable ? `
        <div class="probable-row"><p>You carry one, and this is the nearest spot to where you've been.</p>
          <div class="mini-links"><button class="mini ok" data-act="probable-yes" data-id="${l.id}">Yes, found it here</button>
          <button class="mini" data-act="probable-no" data-id="${l.id}">Not here</button></div></div>` : ''}${carriedUnplaced(l) ? `
        <div class="probable-row"><p>You carry one, but your save doesn't say which spot it came from.</p>
          <div class="mini-links"><button class="mini ok" data-act="carried-here" data-id="${l.id}">It came from here</button></div></div>` : ''}`,
      details: `
        ${l.s ? `<button class="shot-btn" data-act="shot" aria-label="Show the screenshot full screen"><img class="shot" src="screenshots/${encodeURIComponent(l.s)}" alt="Screenshot of ${esc(l.t)}"></button>` : ''}
        ${waysIn(l)}
        ${l.d ? `<p>${esc(l.d)}</p>` : ''}
        ${l.u ? '<p class="note">Couldn\'t find this one in the game files, so this spot may be off.</p>' : ''}
        ${l.parked ? `<p class="note">Where it was at your last save${l.parked.moved ? ' (you moved it from where it starts)' : ''}.</p>` : ''}
        ${needList(l)}
        ${insideList(l)}
        <div class="meta"><span>X ${Math.round(l.x)} · Z ${Math.round(l.y)}</span></div>
        ${links ? `<div class="mini-links">${links}</div>` : ''}`,
      actions: `${guideButton(`loc:${l.id}`)}
        <button class="secondary found-btn${isFound ? ' is-found' : ''}" data-act="toggle-found"${isFound ? ' title="Tap to undo"' : ''}>${isFound ? '✓ Found' : 'Mark as found'}</button>`,
    });
  }

  // Explore: a locked spot you came across. Where it is and what it needs show; what's there doesn't.
  function renderLock(l) {
    const state = lockState(l);
    const area = l.a && AREA[l.a] ? AREA[l.a].name : '';
    detail.innerHTML = cardHtml({
      icon: `<span class="ico lock-ico ${state}">${state === 'open' ? OPEN_SVG : LOCK_SVG}</span>`,
      title: nameOf(l), kind: `${area ? area + ' · ' : ''}you've been here`,
      peek: `${distanceLine(l.x, l.y)}<div class="tags"><span class="tag ${state}">${esc(lockTitle(l))}</span></div>`,
      details: `${needList(l)}<p class="note">What's here stays hidden until you find it, or look.</p>`,
      actions: `${guideButton(`loc:${l.id}`)}
        <button class="secondary" data-act="reveal-name" data-id="${l.id}">Show what's here</button>`,
    });
  }

  // "Go back": the locked spots you've seen that a found item opens, each with Guide me here.
  function renderUnlocks(id) {
    const n = BY_ID.get(id);
    const spots = openedBy(id);
    const rows = spots.map((l) => `<li><button data-go="${l.id}"><span class="ico lock-ico ${lockState(l)}">${lockState(l) === 'open' ? OPEN_SVG : LOCK_SVG}</span>
        <span class="name">${esc(nameOf(l))}<span class="sub">${esc(whereIs(l))}</span></span></button>
        ${guideButton(`loc:${l.id}`).replace('class="guide-btn', 'class="guide-btn small')}</li>`).join('');
    detail.innerHTML = cardHtml({
      icon: `<span class="ico" style="--c:${CAT[n.c].color}"><img src="icons/${n.i}.webp" alt=""></span>`,
      title: `${nice(n.t)} opens`, kind: spots.length ? `${spots.length} spot${spots.length === 1 ? '' : 's'} you've been to` : "Nothing left you've seen",
      peek: rows ? `<div class="links go-back"><ul>${rows}</ul></div>` : '<p class="note">You did them all.</p>',
      actions: '<button class="secondary" data-act="close">Done</button>',
    });
  }

  function renderPin(p) {
    const k = PIN_KINDS[p.kind] || PIN_KINDS.note;
    detail.innerHTML = cardHtml({
      icon: `<span class="ico" style="--c:${k.color}"><span style="font:700 18px var(--font-display);color:#fff">${k.glyph}</span></span>`,
      title: p.label || 'Your pin', kind: `${k.label} pin`,
      peek: distanceLine(p.x, p.y),
      details: `
        <form class="pin-form" id="pin-form">
          <label class="sr-only" for="pin-label">Pin name</label>
          <input id="pin-label" maxlength="80" placeholder="Name this spot, e.g. Main base" value="${esc(p.label)}">
          <div class="kinds" role="group" aria-label="Pin type">
            ${Object.entries(PIN_KINDS).map(([key, v]) => `
              <button type="button" data-kind="${key}" aria-pressed="${p.kind === key}">
                <span class="ico" style="--c:${v.color}"><span style="font:700 12px var(--font-display);color:#fff">${v.glyph}</span></span>${v.label}
              </button>`).join('')}
          </div>
        </form>
        <div class="meta"><span>X ${Math.round(p.x)} · Z ${Math.round(p.y)}</span></div>`,
      actions: `${guideButton(`pin:${p.id}`)}
        <button class="secondary" data-act="close">Done</button>
        <button class="secondary danger icon-only" data-act="delete-pin" aria-label="Delete pin" title="Delete pin"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button>`,
    });
  }

  detail.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) return select({ kind: 'loc', id: Number(go.dataset.go) }, { fly: true });
    const kind = e.target.closest('[data-kind]');
    if (kind && selected?.kind === 'pin') {
      const p = store.pins.find((x) => x.id === selected.id);
      p.kind = kind.dataset.kind;
      updatePin(p);
      return renderDetail();
    }
    const actEl = e.target.closest('[data-act]');
    const act = actEl?.dataset.act;
    const actId = actEl?.dataset.id ? Number(actEl.dataset.id) : null;
    if (act === 'close') closeDetail();
    if (act === 'more') setExpanded(!expanded);
    if (act === 'need') {
      openNeeds.has(actId) ? openNeeds.delete(actId) : openNeeds.add(actId);
      return renderDetail();
    }
    if (act === 'go-need') return goToNeed(actId, actEl.dataset.reveal === '1');
    if (act === 'reveal-name') { reveal([actId]); return renderDetail(); }
    if (act === 'reveal-inside') { reveal(BY_ID.get(actId).n || []); return renderDetail(); }
    if (act === 'reveal-ways') { reveal(entrancesFor(BY_ID.get(actId)).map((x) => x.id)); return renderDetail(); }
    if (act === 'probable-yes') return confirmProbable(actId, true);
    if (act === 'probable-no') return confirmProbable(actId, false);
    if (act === 'carried-here') return setFound([actId], true);
    if (act === 'show-all') {
      openLists.add(e.target.closest('[data-list]').dataset.list);
      renderDetail();
    }
    if (act === 'shot') {
      const img = e.target.closest('[data-act]').querySelector('img');
      shotView.querySelector('img').src = img.src;
      shotView.querySelector('img').alt = img.alt;
      shotView.hidden = false;
    }
    if (act === 'open-area') {
      const area = AREA[e.target.closest('[data-area]').dataset.area];
      closeDetail();
      showArea(area, { manual: true });
    }
    if (act === 'toggle-found' && selected?.kind === 'loc') setFound([selected.id], !store.found.has(selected.id));
    if (act === 'guide') {
      toggleGuide(e.target.closest('[data-guide]').dataset.guide);
      if (store.target && phoneLayout.matches) setExpanded(false); // so the guide chip and the line show
    }
    if (act === 'delete-pin' && selected?.kind === 'pin') deletePin(selected.id);
  });
  let labelTimer;
  detail.addEventListener('input', (e) => {
    if (e.target.id !== 'pin-label' || selected?.kind !== 'pin') return;
    const p = store.pins.find((x) => x.id === selected.id);
    p.label = e.target.value;
    detail.querySelector('h2').textContent = p.label || 'Your pin';
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => updatePin(p), 400);
  });
  detail.addEventListener('submit', (e) => { e.preventDefault(); closeDetail(); });

  // ---------- sidebar ----------
  function counts(keys) {
    let total = 0;
    let found = 0;
    for (const l of LOCS) {
      if (!keys.includes(l.c)) continue;
      total++;
      if (store.found.has(l.id)) found++;
    }
    return { total, found };
  }

  function renderSidebar() {
    renderUnlock();
    onFoundChange?.();
    $('#summary').innerHTML = SUMMARY.map((s) => {
      const keys = CATS.filter((c) => c.group === s.group && !s.skip.includes(c.key)).map((c) => c.key);
      const { total, found } = counts(keys);
      const pct = total ? (found / total) * 100 : 0;
      return `<div class="stat"><div class="stat-label">${s.label}</div>
        <div class="stat-value">${found}<small>/${total}</small></div>
        <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div></div>`;
    }).join('');

    $('#categories').innerHTML = GROUPS.map((g) => {
      const cats = CATS.filter((c) => c.group === g);
      const allOn = cats.every((c) => !hidden.has(c.key));
      const gc = counts(cats.map((c) => c.key));
      return `<section>
        <div class="group-head"><h2>${g}</h2><span class="count">${gc.found}/${gc.total}</span>
          <button data-group="${g}" data-on="${allOn ? 0 : 1}">${allOn ? 'Hide group' : 'Show group'}</button></div>
        <div class="cats">${cats.map((c) => {
          const n = counts([c.key]);
          return `<button class="cat${hidden.has(c.key) ? ' off' : ''}" data-cat="${c.key}" aria-pressed="${!hidden.has(c.key)}">
            <span class="ico" style="--c:${c.color}"><img src="icons/${c.icon}.webp" alt=""></span>
            <span class="name">${esc(c.label)}</span><span class="n">${n.found}/${n.total}</span></button>`;
        }).join('')}</div></section>`;
    }).join('');
  }

  $('#categories').addEventListener('click', (e) => {
    const cat = e.target.closest('[data-cat]');
    const group = e.target.closest('[data-group]');
    if (cat) {
      const k = cat.dataset.cat;
      hidden.has(k) ? hidden.delete(k) : hidden.add(k);
    } else if (group) {
      const on = group.dataset.on === '1';
      CATS.filter((c) => c.group === group.dataset.group).forEach((c) => (on ? hidden.delete(c.key) : hidden.add(c.key)));
    } else return;
    savePrefs();
    applyFilters();
    renderSidebar();
  });
  $('#show-all').onclick = () => { hidden.clear(); savePrefs(); applyFilters(); renderSidebar(); };
  $('#hide-all').onclick = () => { CATS.forEach((c) => hidden.add(c.key)); savePrefs(); applyFilters(); renderSidebar(); };

  const hideFoundBox = $('#hide-found');
  hideFoundBox.checked = prefs.hideFound;
  hideFoundBox.onchange = () => { prefs.hideFound = hideFoundBox.checked; savePrefs(); applyFilters(); };

  const trailBox = $('#show-trail');
  trailBox.checked = prefs.showTrail;
  trailBox.onchange = () => setShowTrail(trailBox.checked);

  const autoBox = $('#auto-mark');
  autoBox.checked = prefs.autoMark;
  autoBox.onchange = () => { prefs.autoMark = autoBox.checked; savePrefs(); autoMark(); };

  let clearArmed = null;
  let clearArmedAt = 0;
  $('#clear-trail').onclick = async (e) => {
    const btn = e.currentTarget;
    if (clearArmed && performance.now() - clearArmedAt < 450) return; // a double click isn't a second, deliberate tap
    if (!clearArmed) {
      clearArmedAt = performance.now();
      btn.textContent = 'Tap again to reset';
      clearArmed = setTimeout(() => { btn.textContent = 'Reset trail'; clearArmed = null; }, 3000);
      return;
    }
    clearTimeout(clearArmed);
    clearArmed = null;
    btn.textContent = 'Reset trail';
    resetTrail();
  };

  function renderPinList() {
    const el = $('#pin-list');
    if (!store.pins.length) {
      el.innerHTML = '<p class="empty">No pins yet. Right-click or long-press the map to drop one on your base, a stash or anything else.</p>';
      return;
    }
    el.innerHTML = store.pins.map((p) => {
      const k = PIN_KINDS[p.kind] || PIN_KINDS.note;
      return `<button data-pin="${esc(p.id)}"><span class="ico" style="--c:${k.color};width:22px;height:22px"><span style="font:700 11px var(--font-display);color:#fff">${k.glyph}</span></span>${esc(p.label || k.label + ' pin')}</button>`;
    }).join('');
  }
  $('#pin-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pin]');
    if (!b) return;
    closeDrawer();
    select({ kind: 'pin', id: b.dataset.pin }, { fly: true });
  });

  // ---------- search ----------
  const searchBox = $('#search');
  const results = $('#search-results');
  let lastResults = [];
  let searchAllFor = null; // Explore: this search also covers what you haven't found (the red button)
  function runSearch() {
    const q = searchBox.value.trim().toLowerCase();
    if (q.length < 2) { results.hidden = true; return; }
    const words = q.split(/\s+/);
    const open = !exploring() || searchAllFor === q;
    lastResults = LOCS.filter((l) => {
      if (!open && (!knows(l) || hiddenLock(l))) return false;
      const hay = `${l.t} ${l.d || ''} ${CAT[l.c].label} ${(l.g || []).join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }).sort((a, b) => Number(!a.t.toLowerCase().includes(words[0])) - Number(!b.t.toLowerCase().includes(words[0]))).slice(0, 40);
    const spoiler = (l) => exploring() && !knows(l) ? ' <span class="spoiler-tag">spoiler</span>' : '';
    results.innerHTML = (lastResults.length ? lastResults.map((l) => `
      <li><button data-go="${l.id}"><span class="ico" style="--c:${CAT[l.c].color};width:24px;height:24px"><img src="icons/${l.i}.webp" alt=""></span>
      <span>${esc(nice(l.t))}${store.found.has(l.id) ? ' <span style="color:var(--found)">✓</span>' : ''}${spoiler(l)}<span class="sub">${esc(CAT[l.c].label)}${l.d ? ' · ' + esc(l.d.slice(0, 60)) : ''}</span></span></button></li>`).join('')
      : `<li class="empty">${open ? 'Nothing matches. Try another word.' : "Nothing you've found matches."}</li>`)
      + (open ? '' : '<li class="spoiler-row"><button data-act="search-all">Search everything (spoilers)</button></li>');
    results.hidden = false;
  }
  searchBox.addEventListener('input', runSearch);
  searchBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && lastResults[0]) goTo(lastResults[0].id);
    if (e.key === 'Escape') { searchBox.value = ''; results.hidden = true; }
  });
  results.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="search-all"]')) { searchAllFor = searchBox.value.trim().toLowerCase(); return runSearch(); }
    const b = e.target.closest('[data-go]');
    if (b) goTo(Number(b.dataset.go));
  });
  function goTo(id) {
    results.hidden = true;
    searchAllFor = null;
    const l = BY_ID.get(id);
    if (exploring() && l && !knows(l)) reveal([id]); // picked from "search everything": you chose to see it
    closeDrawer();
    select({ kind: 'loc', id }, { fly: true });
  }

  // ---------- "To unlock" (Explore): what the locked spots you've seen need ----------
  let unlockOpen = null;
  function renderUnlock() {
    const el = $('#unlock');
    const seen = LOCKS.filter((l) => lockSeen(l) && !store.found.has(l.id));
    if (!exploring() || !seen.length) { el.hidden = true; return; }
    const need = new Map(); // needed item -> the locks it's for
    for (const l of seen) for (const { id } of needsOf(l)) { if (!need.has(id)) need.set(id, []); need.get(id).push(l); }
    el.hidden = false;
    el.innerHTML = `<h2>To unlock</h2><ul>${[...need].map(([id, locks]) => {
      const n = BY_ID.get(id);
      if (!n) return '';
      const have = store.found.has(id);
      const chain = needChain(n);
      const body = unlockOpen !== id ? ''
        : have ? `<div class="reveal-row"><span>You have it.</span><button class="mini" data-act="go-back" data-id="${id}">Go back to ${locks.length === 1 ? 'it' : 'them'}</button></div>`
        : revealRow(n);
      return `<li class="${have ? 'have' : ''}"><button data-unlock="${id}" aria-expanded="${unlockOpen === id}">
          <span class="ico" style="--c:${CAT[n.c].color}"><img src="icons/${n.i}.webp" alt=""></span>
          <span class="name">${esc(nice(n.t))}<span class="sub">opens ${locks.length} spot${locks.length === 1 ? '' : 's'} you've seen</span>${chain ? `<span class="sub chain">${chain}</span>` : ''}</span>
          ${have ? '<span class="done">✓</span>' : ''}</button>${body}</li>`;
    }).join('')}</ul>`;
  }
  $('#unlock').addEventListener('click', (e) => {
    const row = e.target.closest('[data-unlock]');
    if (row) { const id = Number(row.dataset.unlock); unlockOpen = unlockOpen === id ? null : id; return renderUnlock(); }
    const actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    const id = Number(actEl.dataset.id);
    if (actEl.dataset.act === 'go-need') goToNeed(id, actEl.dataset.reveal === '1');
    if (actEl.dataset.act === 'go-back') { closeDrawer(); select({ kind: 'unlocks', id }); }
  });

  // ---------- switching modes: one slider in the top bar ----------
  // The knob shows the mode you're in; the other one peeks out beside it. Tap it, or drag the knob across.
  // Explore -> Guide stops halfway with a small warning; Guide -> Explore goes straight back.
  const modeSwitch = $('#mode-switch');
  const MODE_ICON = {
    explore: '<svg viewBox="0 0 24 24"><g class="fill"><ellipse cx="8.5" cy="7.5" rx="2.7" ry="4.2"/><ellipse cx="15.5" cy="11.5" rx="2.7" ry="4.2"/>'
      + '<rect x="6.7" y="13.3" width="3.6" height="3.4" rx="1.7"/><rect x="13.7" y="17.3" width="3.6" height="3.4" rx="1.7"/></g></svg>',
    guide: '<svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h7a3 3 0 000-6H9a3 3 0 010-6h7"/></svg>',
  };
  function renderMode() {
    const guide = !exploring();
    document.body.classList.toggle('mode-guide', guide);
    modeSwitch.classList.toggle('guide', guide);
    modeSwitch.classList.remove('pending');
    modeSwitch.setAttribute('aria-checked', guide);
    modeSwitch.setAttribute('aria-label', `Map mode: ${guide ? 'Guide' : 'Explore'}`);
    modeSwitch.title = guide ? 'Guide: everything, spoilers included. Tap for Explore.' : "Explore: only what you've found. Tap or slide for Guide.";
    modeSwitch.querySelector('.ms-label').textContent = guide ? 'Guide' : 'Explore';
    modeSwitch.querySelector('.ms-icon').innerHTML = MODE_ICON[guide ? 'guide' : 'explore'];
  }
  function setMode(mode, { quiet = false } = {}) {
    hideModeWarn();
    if (mode === prefs.mode) return;
    closeBrush();
    prefs.mode = mode;
    savePrefs();
    renderMode();
    LOCS.forEach((l) => paintMarker(l.id));
    applyFilters();
    renderSidebar();
    if (selected) renderDetail();
    drawGuide();
    renderFogBtn();
    drawFog();
    renderExploredStat();
    if (!results.hidden) runSearch();
    if (!quiet) toast(exploring() ? "Explore: only places you've found are shown" : 'Guide: every location is shown, spoilers included');
  }
  // Explore -> Guide asks first (a small card under the slider, a little sheet on phones); back is one tap.
  function askGuide() {
    if (prefs.guideNoWarn) return setMode('guide');
    const box = $('#mode-sheet');
    modeSwitch.classList.add('pending'); // the knob waits halfway until you choose
    box.innerHTML = `<p><strong>Guide shows every location</strong>, including things you haven't found. Spoilers ahead.
      You can go back to Explore any time; your progress stays as it is.</p>
      <div class="mode-warn-actions"><button class="warn-btn" data-mode-go="guide">Switch to Guide</button>
      <button class="text-btn" data-mode-go="stay">Stay in Explore</button></div>
      <label class="switch"><input type="checkbox" id="mode-nowarn"><span>Don't warn me again</span></label>`;
    box.hidden = false;
  }
  function hideModeWarn() { $('#mode-sheet').hidden = true; modeSwitch.classList.remove('pending'); }
  const toggleMode = () => (exploring() ? askGuide() : setMode('explore'));
  // tap, Space or Enter (it's a button), or drag the knob toward the other side
  let slide = null;
  let slid = false;
  modeSwitch.addEventListener('pointerdown', (e) => {
    slide = { x: e.clientX, id: e.pointerId, d: 0 };
    try { modeSwitch.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
  });
  modeSwitch.addEventListener('pointermove', (e) => {
    if (!slide || e.pointerId !== slide.id) return;
    const range = modeSwitch.clientWidth * 0.32;
    slide.d = Math.max(-range, Math.min(range, e.clientX - slide.x));
    const toward = exploring() ? Math.max(0, slide.d) : Math.min(0, slide.d);
    modeSwitch.style.setProperty('--drag', `${toward}px`);
  });
  function endSlide(e, cancelled) {
    if (!slide || e.pointerId !== slide.id) return;
    const range = modeSwitch.clientWidth * 0.32;
    const toward = exploring() ? slide.d : -slide.d;
    slid = Math.abs(slide.d) > 6; // a drag, not a tap: the click that follows is ignored
    slide = null;
    modeSwitch.style.removeProperty('--drag');
    if (slid && !cancelled && toward > range * 0.4) toggleMode();
  }
  modeSwitch.addEventListener('pointerup', (e) => endSlide(e, false));
  modeSwitch.addEventListener('pointercancel', (e) => endSlide(e, true));
  modeSwitch.addEventListener('click', () => {
    if (slid) { slid = false; return; }
    toggleMode();
  });
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-mode-go]');
    if (go) {
      if (go.dataset.modeGo === 'guide' && $('#mode-nowarn')?.checked) { prefs.guideNoWarn = true; savePrefs(); }
      return go.dataset.modeGo === 'guide' ? setMode('guide') : hideModeWarn();
    }
  });
  renderMode();

  // ---------- controls ----------
  $('#zoom-in').onclick = () => map.zoomIn();
  $('#zoom-out').onclick = () => map.zoomOut();
  function centerOnMe() {
    if (!store.position) return toast('No position yet. Save your game and it will show up here.');
    const p = meGlide.shown || store.position;
    flyTo([p.y, p.x], Math.max(map.getZoom(), 0), { duration: 0.6 });
  }
  $('#locate').onclick = centerOnMe;
  $('#status').onclick = centerOnMe;
  $('#follow').onclick = () => {
    setFollowing(!following);
    if (following) { centerOnMe(); toast('Following you. Drag the map to stop.'); }
  };
  const darkBtn = $('#dark-map');
  function applyDarkMap() {
    document.body.classList.toggle('dark-map', prefs.darkMap);
    darkBtn.setAttribute('aria-pressed', prefs.darkMap);
    fogPainted = null; // the mist's colour goes with the map
    drawFog();
  }
  darkBtn.onclick = () => { prefs.darkMap = !prefs.darkMap; savePrefs(); applyDarkMap(); };
  applyDarkMap();
  map.on('dragstart', () => { if (following) setFollowing(false); });

  // ---------- trail menu (on the map, so a phone reaches it without opening the drawer) ----------
  const trailBtn = $('#trail-btn');
  const trailMenu = $('#trail-menu');
  const trailShow = $('#trail-show');
  const exploredShow = $('#explored-show');
  let resetAsking = false;

  function setShowTrail(on) {
    prefs.showTrail = on;
    savePrefs();
    trailBox.checked = on;
    drawTrail();
  }
  function renderTrailMenu() {
    for (const b of trailMenu.querySelectorAll('[data-range]')) b.setAttribute('aria-checked', b.dataset.range === prefs.trailRange);
    trailShow.checked = prefs.showTrail;
    exploredShow.checked = prefs.showExplored;
    exploredShow.closest('label').hidden = !changedPoints(store.worlds.get(store.view)).length;
    const all = currentTrail().length;
    const shown = shownTrail().length;
    $('#trail-count').textContent = !all ? 'No trail in this world yet.'
      : prefs.trailRange === 'all' ? `${all} points` : `${shown} of ${all} points, from ${TRAIL_RANGES[prefs.trailRange]}`;
    $('#trail-reset').innerHTML = resetAsking
      ? `<span>Reset this world's trail?</span><button class="danger-btn" data-reset="yes">Reset</button><button class="text-btn" data-reset="no">Cancel</button>`
      : `<button class="text-btn danger" data-reset="ask"${all ? '' : ' disabled'}>Reset trail</button>`;
  }
  function openTrailMenu(open) {
    trailMenu.hidden = !open;
    trailBtn.setAttribute('aria-expanded', open);
    resetAsking = false;
    if (!open) return;
    trailMenu.style.top = `${trailBtn.getBoundingClientRect().top}px`;
    renderTrailMenu();
  }
  trailBtn.onclick = () => openTrailMenu(trailMenu.hidden);
  document.addEventListener('pointerdown', (e) => {
    if (!trailMenu.hidden && !trailMenu.contains(e.target) && !trailBtn.contains(e.target)) openTrailMenu(false);
  });
  trailMenu.addEventListener('click', (e) => {
    const range = e.target.closest('[data-range]')?.dataset.range;
    if (range) {
      prefs.trailRange = range;
      savePrefs();
      drawTrail();
    }
    const reset = e.target.closest('[data-reset]')?.dataset.reset;
    if (reset === 'ask' || reset === 'no') { resetAsking = reset === 'ask'; renderTrailMenu(); }
    if (reset === 'yes') { resetAsking = false; openTrailMenu(false); resetTrail(); }
  });
  trailShow.onchange = () => setShowTrail(trailShow.checked);
  exploredShow.onchange = () => { prefs.showExplored = exploredShow.checked; savePrefs(); drawExplored(); };

  // ---------- the Fog button: on or off, and how thick ----------
  // A click (tap) turns the fog on or off, for the mode you're in: on in Explore, off in Guide until you turn
  // it on. Its slider (how thick) and how much you've explored show when you point at the button on a PC,
  // and when you turn the fog on on a phone, until you tap somewhere else.
  const fogBtn = $('#fog-btn');
  const fogMenu = $('#fog-menu');
  const fogRange = $('#fog-range');
  let fogAsking = false;
  const fogKey = () => (exploring() ? 'explore' : 'guide');
  function renderFogBtn() {
    const on = !!prefs.fogOn?.[fogKey()];
    fogBtn.setAttribute('aria-pressed', on);
    fogBtn.title = on ? `Fog: on (${prefs.fog}%). Click to turn it off` : 'Fog: off. Click to turn it on';
  }
  function setFogOn(on) {
    prefs.fogOn = { ...prefs.fogOn, [fogKey()]: on };
    savePrefs();
    renderFogBtn();
    drawFog();
    if (!fogMenu.hidden) renderFogMenu();
  }
  function renderFogMenu() {
    const on = !!prefs.fogOn?.[fogKey()];
    fogRange.value = prefs.fog;
    $('#fog-value').textContent = on ? `${prefs.fog}%` : 'Off';
    const stat = $('#explored-stat').querySelector('b')?.textContent;
    const inCave = caveDrawn ? (caveDrawn.area.kind === 'cave' ? 'this cave' : 'this bunker') : null;
    $('#fog-note').textContent = (!on ? 'Fog is off. Slide to turn it on. ' : '') + (inCave ? `You've explored ${caveExplored(caveDrawn.area)}% of ${inCave}.`
      : !fogBits ? 'Nothing explored in this world yet.'
      : stat ? `You've explored ${stat} of the island.` : '');
    $('#fog-brush').hidden = !(exploring() && !cave && !!store.view); // see "the fog brush" below
    $('#fog-reset').innerHTML = !fogAsking
      ? `<button class="text-btn danger" data-fog-reset="ask"${fogBits || inCave ? '' : ' disabled'}>Reset exploration</button>`
      : inCave
        ? `<span>Put the fog back over ${inCave}, or over everything (the island and every cave and bunker)? Your trail and found places stay.</span>
           <button class="danger-btn" data-fog-reset="area">Reset ${inCave}</button><button class="danger-btn" data-fog-reset="yes">Everything</button><button class="text-btn" data-fog-reset="no">Cancel</button>`
        : `<span>Put the fog back over the whole island and its caves and bunkers? Your trail and found places stay.</span><button class="danger-btn" data-fog-reset="yes">Reset</button><button class="text-btn" data-fog-reset="no">Cancel</button>`;
  }
  function openFogMenu(open) {
    fogMenu.hidden = !open;
    fogAsking = false;
    if (!open) return;
    if (!trailMenu.hidden) openTrailMenu(false);
    fogMenu.style.top = `${fogBtn.getBoundingClientRect().top}px`;
    renderFogMenu();
  }
  fogBtn.onclick = () => {
    const on = !prefs.fogOn?.[fogKey()];
    setFogOn(on);
    if (!canHover) openFogMenu(on);
  };
  if (canHover) { // pointing at the button (or its slider) shows the slider; it goes a moment after you leave
    let leaveTimer = 0;
    const show = () => { clearTimeout(leaveTimer); if (fogMenu.hidden) openFogMenu(true); };
    const hide = () => { clearTimeout(leaveTimer); leaveTimer = setTimeout(() => { if (!fogAsking) openFogMenu(false); }, 400); };
    for (const el of [fogBtn, fogMenu]) { el.addEventListener('mouseenter', show); el.addEventListener('mouseleave', hide); }
    fogBtn.addEventListener('focus', show);
  }
  document.addEventListener('pointerdown', (e) => {
    if (!fogMenu.hidden && !fogMenu.contains(e.target) && !fogBtn.contains(e.target)) openFogMenu(false);
  });
  fogRange.addEventListener('input', () => {
    prefs.fog = Number(fogRange.value);
    if (!prefs.fogOn?.[fogKey()]) return setFogOn(true); // sliding turns it on
    $('#fog-value').textContent = `${prefs.fog}%`;
    renderFogBtn();
    drawFog();
  });
  fogRange.addEventListener('change', savePrefs);
  renderFogBtn();
  fogMenu.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-fog-reset]')?.dataset.fogReset;
    if (act === 'ask' || act === 'no') { fogAsking = act === 'ask'; return renderFogMenu(); }
    if (act !== 'yes' && act !== 'area') return;
    fogAsking = false;
    const area = act === 'area' ? caveDrawn?.area : null;
    openFogMenu(false);
    const world = store.view;
    try { await api('explored/reset', { world, area: area?.id }); } catch { return toast('Could not reset the fog. Is the map window on your PC still open?'); }
    toast(area ? `The fog is back over ${area.name}` : 'The fog is back over the island and its caves', {
      action: 'Undo', ms: 6000,
      onAction: async () => {
        try { await api('explored/restore', { world }); toast('Your explored map is back'); } catch { toast('Could not bring it back.'); }
      },
    });
  });

  // ---------- the fog brush (Explore): paint the fog away where you've been, or back where you weren't ----------
  // For what the map can't know, like where you went before you used it. Drag over the map; it doesn't pan
  // while the brush is on (two fingers still zoom on a phone). A stroke is saved when you let go, and Undo
  // takes back the last one. It paints the fog's own 10 m cells, so what you paint is what the fog shows.
  const brushBar = $('#brush-bar');
  const brushBtn = $('#fog-brush');
  let brushMode = 'clear';
  let brushSize = 50; // metres around the pointer
  let brushRing = null; // where a mouse would paint
  let stroke = null; // { on, cells, last } while painting
  let lastStroke = null; // { world, on, cells } for Undo
  let brushFrame = 0;
  let brushChanged = [];
  const brushPointers = new Set();
  const canBrush = () => exploring() && !cave && !!store.view;

  function openBrush() {
    if (!canBrush()) return;
    openFogMenu(false);
    endDraft();
    if (!prefs.fogOn?.explore) setFogOn(true);
    brush = { world: store.view };
    lastStroke = null;
    map.dragging.disable();
    map.doubleClickZoom.disable();
    document.body.classList.add('brushing');
    renderBrushBar();
    brushBar.hidden = false;
  }
  function closeBrush() {
    if (!brush) return;
    endStroke();
    brush = null;
    brushPointers.clear();
    map.dragging.enable();
    map.doubleClickZoom.enable();
    document.body.classList.remove('brushing');
    brushBar.hidden = true;
    brushRing?.remove();
    brushRing = null;
  }
  function renderBrushBar() {
    for (const b of brushBar.querySelectorAll('[data-brush-mode]')) b.setAttribute('aria-checked', b.dataset.brushMode === brushMode);
    for (const b of brushBar.querySelectorAll('[data-brush-size]')) b.setAttribute('aria-checked', Number(b.dataset.brushSize) === brushSize);
    brushBar.querySelector('[data-brush="undo"]').disabled = !lastStroke;
    const how = canHover ? 'Drag over the map' : 'Drag a finger over the map (two fingers zoom)';
    $('#brush-hint').textContent = brushMode === 'clear' ? `${how} to clear the fog where you've been.` : `${how} to put the fog back where you haven't been.`;
  }
  brushBtn.onclick = openBrush;
  brushBar.addEventListener('click', (e) => {
    const mode = e.target.closest('[data-brush-mode]')?.dataset.brushMode;
    const size = e.target.closest('[data-brush-size]')?.dataset.brushSize;
    const act = e.target.closest('[data-brush]')?.dataset.brush;
    if (act === 'done') return closeBrush();
    if (act === 'undo') undoStroke();
    if (mode) brushMode = mode;
    if (size) brushSize = Number(size);
    brushRing?.setRadius(brushSize);
    renderBrushBar();
  });

  // the cells whose middle is within r of (x, z), like the map app's own
  function cellsAround(x, z, r) {
    const out = [];
    const i0 = Math.max(0, Math.floor((x - r - GRID.min) / GRID.cell)); const i1 = Math.min(GRID.size - 1, Math.floor((x + r - GRID.min) / GRID.cell));
    const j0 = Math.max(0, Math.floor((z - r - GRID.min) / GRID.cell)); const j1 = Math.min(GRID.size - 1, Math.floor((z + r - GRID.min) / GRID.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = GRID.min + (i + 0.5) * GRID.cell - x;
        const dz = GRID.min + (j + 0.5) * GRID.cell - z;
        if (dx * dx + dz * dz <= r * r) out.push(j * GRID.size + i);
      }
    }
    return out;
  }
  function setCells(world, cells, on) {
    let bits = store.explored.get(world);
    if (!bits) store.explored.set(world, (bits = new Uint8Array((GRID.size * GRID.size) / 8)));
    const changed = [];
    for (const k of cells) {
      if (!!hasCell(bits, k) === on) continue;
      if (on) bits[k >> 3] |= 1 << (k & 7);
      else bits[k >> 3] &= ~(1 << (k & 7));
      changed.push(k);
    }
    if (world === store.view && fogBits !== bits) { fogBits = bits; fogPainted = null; } // its first explored cells
    if (world === store.view && changed.length) fogChanged();
    return changed;
  }
  function paintAt(latlng) {
    const from = stroke.last || latlng; // between two pointer events too, so a quick stroke is a line and not dots
    const steps = Math.max(1, Math.ceil(Math.hypot(latlng.lng - from.lng, latlng.lat - from.lat) / (brushSize / 2)));
    for (let s = stroke.last ? 1 : 0; s <= steps; s++) {
      const x = from.lng + ((latlng.lng - from.lng) * s) / steps;
      const z = from.lat + ((latlng.lat - from.lat) * s) / steps;
      for (const k of setCells(brush.world, cellsAround(x, z, brushSize), stroke.on)) {
        stroke.cells.add(k);
        brushChanged.push(k);
      }
    }
    stroke.last = latlng;
    if (!brushFrame) brushFrame = requestAnimationFrame(brushRepaint);
  }
  function brushRepaint() {
    brushFrame = 0;
    const cells = brushChanged;
    brushChanged = [];
    if (!cells.length) return;
    if (fogPainted === fogBits) repaintAround(cells);
    else { drawFog(); renderExploredStat(); }
  }
  function endStroke() {
    const s = stroke;
    stroke = null;
    if (!s?.cells.size) return;
    lastStroke = { world: brush.world, on: s.on, cells: [...s.cells] };
    renderBrushBar();
    sendPaint(lastStroke);
  }
  function undoStroke() {
    const s = lastStroke;
    if (!s) return;
    lastStroke = null;
    const changed = setCells(s.world, s.cells, !s.on);
    if (s.world === store.view && changed.length) { brushChanged.push(...changed); brushRepaint(); }
    sendPaint({ ...s, on: !s.on });
  }
  async function sendPaint({ world, cells, on }) {
    if (!store.online) return toast('The fog brush needs the map window on your PC.');
    try {
      for (let i = 0; i < cells.length; i += 20000) await api('explored/paint', { world, cells: cells.slice(i, i + 20000), on });
    } catch {
      toast('Could not save the fog. Is the map window on your PC still open?');
    }
  }
  mapEl.addEventListener('pointerdown', (e) => {
    if (!brush || e.target.closest('.leaflet-control-container')) return;
    brushPointers.add(e.pointerId);
    if (brushPointers.size > 1) { endStroke(); return; } // a second finger: that's a zoom
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    stroke = { on: brushMode === 'clear', cells: new Set(), last: null };
    paintAt(map.mouseEventToLatLng(e));
  }, true);
  mapEl.addEventListener('pointermove', (e) => {
    if (!brush) return;
    const at = map.mouseEventToLatLng(e);
    if (e.pointerType === 'mouse') {
      if (brushRing) brushRing.setLatLng(at);
      else brushRing = L.circle(at, { radius: brushSize, color: '#fff', weight: 1.5, dashArray: '4 4', fill: false, interactive: false }).addTo(map);
    }
    if (stroke && brushPointers.size === 1) paintAt(at);
  });
  for (const ev of ['pointerup', 'pointercancel']) {
    window.addEventListener(ev, (e) => { brushPointers.delete(e.pointerId); if (stroke) endStroke(); });
  }
  mapEl.addEventListener('pointerleave', () => { brushRing?.remove(); brushRing = null; });

  // Removes the trail of the world on screen (not your other worlds); Undo brings it back for a few seconds.
  async function resetTrail() {
    const world = store.view || store.position?.world || null;
    const removed = new Set(currentTrail());
    if (!removed.size) return toast('No trail to reset.');
    store.trail = store.trail.filter((p) => !removed.has(p));
    drawTrail();
    if (store.online) {
      try { await api('trail/clear', { world }); } catch { return toast('Could not reset the trail. Is the map window on your PC still open?'); }
    }
    toast(`Trail reset (${removed.size} points)`, {
      action: 'Undo', ms: 6000,
      onAction: async () => {
        if (store.online) {
          try { await api('trail/restore', { world }); } catch { return toast('Could not bring the trail back.'); }
        } else {
          store.trail = [...store.trail, ...removed].sort((a, b) => a.t - b.t);
          drawTrail();
        }
        toast('Trail is back');
      },
    });
  }

  $('#add-pin').onclick = () => (draft ? endDraft() : startDraft(map.getCenter()));
  // A click (or tap) on empty map starts a pin there. When a card, the search results, a menu or a fanned-out
  // pile is open, that click only closes it. What was open is noted when the press starts, because the
  // menus close themselves on the press. A double click zooms, so the pin waits a moment for it.
  let dismissing = false;
  let pendingDraft = 0;
  mapEl.addEventListener('pointerdown', () => {
    dismissing = !!selected || !results.hidden || !trailMenu.hidden || !fogMenu.hidden || !$('#mode-sheet').hidden || !!spread;
  }, true);
  map.on('click', (e) => {
    if (brush) return; // painting the fog
    if (draft) return moveDraft(e.latlng);
    if (dismissing) {
      dismissing = false;
      if (selected) closeDetail();
      results.hidden = true;
      hideModeWarn();
      return;
    }
    clearTimeout(pendingDraft);
    pendingDraft = setTimeout(() => startDraft(e.latlng), 260);
  });
  map.on('dblclick', () => clearTimeout(pendingDraft));
  // A right-click drops a pin, or cancels the one you're placing (a misclick); a long-press on a phone moves it.
  map.on('contextmenu', (e) => {
    clearTimeout(pendingDraft);
    if (brush) return;
    if (draft && canHover) return endDraft();
    startDraft(e.latlng);
  });

  const readout = $('#readout');
  map.on('mousemove', (e) => {
    const d = store.position ? ` · ${fmtDist(Math.hypot(e.latlng.lng - store.position.x, e.latlng.lat - store.position.y))} from you` : '';
    readout.textContent = `X ${Math.round(e.latlng.lng)}  Z ${Math.round(e.latlng.lat)}${d}`;
  });
  map.on('mouseout', () => { readout.textContent = ''; });

  // drawer (phones)
  const appEl = $('#app');
  const scrim = $('#scrim');
  function openDrawer() { appEl.classList.add('drawer-open'); scrim.hidden = false; }
  function closeDrawer() { appEl.classList.remove('drawer-open'); scrim.hidden = true; }
  $('#menu-btn').onclick = openDrawer;
  $('#close-drawer').onclick = closeDrawer;
  scrim.onclick = closeDrawer;

  // phone modal
  const phoneModal = $('#phone-modal');
  let qrMade = false;
  $('#phone-btn').onclick = () => {
    const url = store.info?.phoneUrl;
    if (!url) return toast(store.online ? 'Phone access is off. Start the map without --local-only.' : 'Start the map on your PC first.');
    $('#phone-url').textContent = url;
    if (!qrMade && window.QRCode) {
      new QRCode($('#qr'), { text: url, width: 200, height: 200, colorDark: '#101412', colorLight: '#ffffff' });
      qrMade = true;
    }
    phoneModal.hidden = false;
  };
  $('#phone-close').onclick = () => { phoneModal.hidden = true; };
  phoneModal.onclick = (e) => { if (e.target === phoneModal) phoneModal.hidden = true; };

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      if (!shotView.hidden) shotView.hidden = true;
      else if (brush) closeBrush();
      else if (!chooser.hidden) { chooserDismissed = true; closeChooser(); renderWorldPick(); }
      else if (!trailMenu.hidden) openTrailMenu(false);
      else if (!phoneModal.hidden) phoneModal.hidden = true;
      else if (draft) endDraft();
      else if (selected) closeDetail();
      else closeDrawer();
    }
    if (e.key === 'Enter' && draft && !typing) { e.preventDefault(); placeDraft(); }
    if (!typing && (e.key === 'f' || e.key === 'F') && selected?.kind === 'loc') {
      setFound([selected.id], !store.found.has(selected.id));
    }
    if (!typing && e.key === '/') { e.preventDefault(); searchBox.focus(); }
  });

  // ---------- helpers ----------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function round(n) { return Math.round(n * 100) / 100; }
  function fmtDist(m) { return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; }
  function distanceText(x, y) {
    const pos = store.position;
    if (!pos) return '';
    const dx = x - pos.x;
    const dz = y - pos.y;
    const d = Math.hypot(dx, dz);
    if (d < 15) return '<span>You are here</span>';
    const where = pos.source === 'live' ? 'you' : 'your last save';
    return `<span>${fmtDist(d)} ${compass(dx, dz)} of ${where}</span>`;
  }
  function compass(dx, dz) {
    const bearing = (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360;
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearing / 45) % 8];
  }
  // Data names like "BunkerEntertainment" read better as "Bunker Entertainment".
  function nice(t) { return String(t).replace(/([a-z])([A-Z])/g, '$1 $2'); }
  function agoShort(t) {
    const s = Math.max(0, Date.now() / 1000 - t);
    if (s < 90) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }
  function ago(t) {
    const s = Math.max(0, Date.now() / 1000 - t);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }
  let toastTimer;
  let toastKeepUntil = 0; // a toast that others wait for (something you just found), until then
  function toast(msg, { action, onAction, ms = 2800, keep = false } = {}) {
    if (welcomeStep) { heldToast = [msg, { action, onAction, ms }]; return; } // after the welcome, not under it
    const wait = toastKeepUntil - performance.now();
    if (!keep && wait > 0) { setTimeout(() => toast(msg, { action, onAction, ms }), wait); return; }
    if (keep) toastKeepUntil = performance.now() + ms;
    const el = $('#toast');
    el.textContent = msg;
    if (action) {
      const b = document.createElement('button');
      b.className = 'toast-action';
      b.textContent = action;
      b.onclick = () => { el.hidden = true; onAction(); };
      el.append(b);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------- "Guide me here": one target per world, shown here and as an arrow in the game ----------
  const guideLayer = L.layerGroup().addTo(map);
  const guideChip = $('#guide-chip');
  let guideLine = null; // from you to the target; its start moves with your marker

  function guideButton(key) {
    const on = store.target?.id === key;
    return `<button class="guide-btn${on ? ' on' : ''}" data-act="guide" data-guide="${esc(key)}">${on ? 'Stop guiding' : 'Guide me here'}</button>`;
  }

  // What a card's guide key points at: a location, a pin or a camp.
  function guideTargetFor(key) {
    const [kind, rest] = key.split(/:(.*)/s);
    if (kind === 'loc') {
      const l = BY_ID.get(Number(rest));
      return l && { x: l.x, y: l.y, label: nameOf(l), kind, id: key };
    }
    if (kind === 'pin') {
      const p = store.pins.find((x) => x.id === rest);
      return p && { x: p.x, y: p.y, label: p.label || (PIN_KINDS[p.kind] || PIN_KINDS.note).label, kind, id: key };
    }
    if (kind === 'glider') {
      const g = myGliders().find((x) => `${Math.round(x.x)},${Math.round(x.y)}` === rest);
      return g && { x: g.x, y: g.y, h: g.h, label: 'Your glider', kind, id: key };
    }
    const c = (store.world?.camps || []).find((x) => `${Math.round(x.x)},${Math.round(x.y)}` === rest);
    return c && { x: c.x, y: c.y, h: c.h, label: 'Your camp', kind: 'camp', id: key };
  }

  function toggleGuide(key) {
    setTarget(store.target?.id === key ? null : guideTargetFor(key));
  }

  function setTarget(target) {
    store.target = target || null;
    const w = store.worlds.get(store.view);
    if (w) w.target = store.target;
    drawGuide();
    if (selected) renderDetail();
    if (target) toast(`Guiding you to ${target.label}. The arrow shows in the game.`);
    if (store.online) persist('target', { target: store.target });
  }

  let guideFor = null; // the target the ring is drawn for
  function drawGuide() {
    const t = store.target;
    guideChip.hidden = !t;
    const key = t ? `${t.id}|${t.x}|${t.y}` : null;
    if (key !== guideFor) {
      guideLayer.clearLayers();
      guideLine = null;
      guideFor = key;
      if (t) {
        L.marker([t.y, t.x], {
          icon: L.divIcon({ className: 'me-icon', html: '<div class="guide-ring"></div>', iconSize: [0, 0] }),
          interactive: false, keyboard: false, zIndexOffset: -100,
        }).addTo(guideLayer);
      }
    }
    if (!t) return;
    const pos = store.position;
    const mine = pos && !unchosen() && (!pos.world || !store.view || pos.world === store.view);
    let text = `Guiding to ${t.label}`;
    if (!mine && guideLine) {
      guideLayer.removeLayer(guideLine);
      guideLine = null;
    }
    if (mine) {
      const from = meGlide.shown || pos;
      if (guideLine) guideLine.setLatLngs([[from.y, from.x], [t.y, t.x]]);
      else guideLine = L.polyline([[from.y, from.x], [t.y, t.x]], { color: '#ffd166', weight: 2.5, opacity: 0.9, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(guideLayer);
      const d = Math.hypot(t.x - pos.x, t.y - pos.y);
      text += d < 10 ? ' · you are there' : ` · ${fmtDist(d)} ${compass(t.x - pos.x, t.y - pos.y)}`;
    }
    $('#guide-text').textContent = text;
  }
  $('#guide-stop').onclick = () => setTarget(null);
  $('#guide-text').onclick = () => { if (store.target) flyTo([store.target.y, store.target.x], Math.max(map.getZoom(), 0), { duration: 0.6 }); };

  // ---------- worlds (each world has its own found markers, pins, trail, camps and vehicles) ----------
  const worldPick = $('#world-pick');
  const MODE_NAMES = { SinglePlayer: 'single player', Multiplayer: 'co-op host', MultiplayerClient: 'co-op' };

  function worldName(w) {
    if (!w) return '';
    if (w.new) return `${w.difficulty || 'New'} world (not saved yet)`;
    const since = new Date(w.started * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${w.difficulty || 'World'} world from ${since}`;
  }
  function worldDetail(w) {
    if (!w || w.new) return '';
    const modes = (w.modes || []).map((m) => MODE_NAMES[m] || m).join(' + ');
    return [w.day != null ? `Day ${w.day}` : '', modes].filter(Boolean).join(' · ');
  }

  // Called with the server's list. The map shows the game you play; when you stop, it stays on that one. Not
  // playing and nothing picked (or that game is gone: a new one you never saved), it asks which game.
  function setWorlds(active, list, { quiet = false } = {}) {
    const before = store.active;
    const shown = store.view;
    store.worlds = new Map((list || []).map((w) => [w.uid, w]));
    store.explored = new Map((list || []).filter((w) => w.explored).map((w) => [w.uid, bitsFrom(w.explored)]));
    store.exploredUnder = new Map((list || []).map((w) => [w.uid, new Map(Object.entries(w.exploredUnder || {}).map(([id, b]) => [id, bitsFrom(b)]))]));
    store.active = active;
    const playing = liveFresh() && store.position.world === active;
    if (playing && before !== active) { store.viewPinned = false; store.pickedSave = null; } // you started playing: show that game
    if (store.view && !store.worlds.has(store.view)) { store.view = null; store.viewPinned = false; }
    if (!store.view && !playing) {
      if (shown) { closeBrush(); endDraft(); showNothing(); }
      openChooser();
      renderWorldPick();
      return;
    }
    if (!store.view || (playing && !store.viewPinned)) store.view = active;
    if (store.view !== shown) { closeBrush(); endDraft(); }
    if (playing) closeChooser();
    if (!quiet && playing && before && before !== active && store.worlds.has(active)) {
      const w = store.worlds.get(active);
      toast(`Now playing: ${worldName(w)}${worldDetail(w) ? ' · ' + worldDetail(w) : ''}`);
    }
    showWorld(store.view);
    renderWorldPick();
  }
  // No game on screen: an empty map (Explore shows nothing you haven't found, and there's no game to have found it in).
  function showNothing() {
    store.found = new Set();
    store.pins = [];
    store.target = null;
    for (const k of MARK_LISTS) store[k] = new Set();
    for (const l of LOCS) { // vehicles back where they start
      if (l.x0 === undefined) continue;
      l.x = l.x0;
      l.y = l.y0;
      delete l.parked;
      markers.get(l.id)?.setLatLng([l.y, l.x]);
    }
    applyWorld({ camps: [], vehicles: [], time: 0 });
    setFogWorld();
    LOCS.forEach((l) => paintMarker(l.id));
    applyFilters();
    renderSidebar();
    drawPins();
    drawTrail();
    drawMe();
    drawGuide();
  }

  // Where "you" are on the map of the game on screen: live while you play it; otherwise the save you picked,
  // or the newest of that game (the map app's own position may be another game's save).
  function effectivePosition() {
    const p = store.serverPosition;
    if (!store.view || (p?.source === 'live' && Date.now() / 1000 - p.time < 20)) return p;
    if (store.pickedSave?.world === store.view) return { ...store.pickedSave, source: 'save' };
    if (p && (!p.world || p.world === store.view)) return p;
    const s = store.worlds.get(store.view)?.saveList?.[0];
    return s ? { ...s, source: 'save', world: store.view } : p;
  }
  function refreshPosition() { store.position = effectivePosition(); }

  function showWorld(uid) {
    const w = store.worlds.get(uid);
    if (!w) return;
    if (uid !== store.view) { endDraft(); closeBrush(); }
    store.view = uid;
    refreshPosition();
    store.found = new Set(w.found || []);
    store.pins = w.pins || [];
    store.target = w.target || null;
    for (const k of MARK_LISTS) store[k] = new Set(w[k] || []);
    encounterChecked = 0;
    // vehicles go back to where they start before this world's parking spots are applied
    for (const l of LOCS) {
      if (l.x0 === undefined) continue;
      l.x = l.x0;
      l.y = l.y0;
      delete l.parked;
      markers.get(l.id)?.setLatLng([l.y, l.x]);
    }
    applyWorld({ camps: w.camps, vehicles: w.vehicles, time: w.last });
    setFogWorld();
    setTimeout(applyHistory, 0); // after the found markers of this world are in
    LOCS.forEach((l) => paintMarker(l.id));
    applyFilters();
    renderSidebar();
    drawPins();
    drawTrail();
    drawMe();
    drawGuide();
    if (selected) renderDetail();
  }

  const newestFirst = () => [...store.worlds.values()].sort((a, b) => (b.last || 0) - (a.last || 0));
  const playingNow = (uid) => liveFresh() && store.position.world === uid;
  function renderWorldPick() {
    const list = newestFirst();
    worldPick.closest('.world-pick').hidden = list.length < 2 && !!store.view;
    $('#choose-save').hidden = !list.some((w) => w.saveList?.length);
    worldPick.innerHTML = (store.view ? '' : '<option value="" selected>Choose a game…</option>')
      + list.map((w) => `<option value="${esc(w.uid)}"${w.uid === store.view ? ' selected' : ''}>${esc(worldName(w))}${worldDetail(w) ? ' · ' + esc(worldDetail(w)) : ''}${playingNow(w.uid) ? ' · playing' : ''}</option>`).join('');
  }
  worldPick.onchange = () => { if (worldPick.value) chooseWorld(worldPick.value); };
  // A game to look at (its newest save, or the save you picked): the map goes to where you were in it.
  function chooseWorld(uid, save = null) {
    store.pickedSave = save ? { ...save, world: uid } : null;
    store.viewPinned = !playingNow(uid);
    closeChooser();
    closeDetail();
    showWorld(uid);
    renderWorldPick();
    const at = store.position?.world === uid ? store.position : null;
    if (at && !cave) map.setView([at.y, at.x], Math.max(map.getZoom(), -1), { animate: false });
  }
  // The start screen. The game you play shows by itself; until you play (the game isn't running, or you're
  // still in its menu), the map waits for it, and you can look at any of your saves, newest first, instead
  // of the map just showing the one you saved last.
  const chooser = $('#world-choose');
  const CHOOSE_FIRST = 8;
  let chooserDismissed = false;
  let chooserAll = false;
  function allSaves() {
    return newestFirst().flatMap((w) => (w.saveList || []).map((s) => ({ w, s }))).sort((a, b) => b.s.time - a.s.time);
  }
  function openChooser({ asked = false } = {}) {
    if (!asked && (chooserDismissed || store.view)) return;
    if (!store.worlds.size || welcomeStep) return; // after the welcome (closeWelcome asks)
    const saves = allSaves();
    const shown = chooserAll ? saves : saves.slice(0, CHOOSE_FIRST);
    $('#choose-list').innerHTML = shown.map(({ w, s }, i) => {
      const when = new Date(s.time * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const what = [worldName(w), MODE_NAMES[s.mode] || s.mode].filter(Boolean).join(' · ');
      return `<button class="welcome-option" data-choose="${i}"><strong>${s.day != null ? `Day ${esc(s.day)}` : 'Save'} · ${esc(when)}</strong>`
        + `<span>${esc(ago(s.time))} · ${esc(what)}</span></button>`;
    }).join('') || '<p class="welcome-note">No saves on this PC yet.</p>';
    chooser.shownSaves = shown;
    chooser.querySelector('.start-wait').hidden = liveFresh() && store.worlds.has(store.position.world); // playing already
    const more = $('#choose-more');
    more.hidden = chooserAll || saves.length <= CHOOSE_FIRST;
    more.textContent = `Show all ${saves.length} saves`;
    chooser.hidden = false;
  }
  function closeChooser() { chooser.hidden = true; }
  chooser.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-choose]')?.dataset.choose;
    if (!pick && e.target !== chooser) return;
    if (pick === 'more') { chooserAll = true; return openChooser({ asked: true }); }
    if (!pick || pick === 'wait') { chooserDismissed = true; closeChooser(); renderWorldPick(); return; }
    const it = chooser.shownSaves?.[Number(pick)];
    if (it) chooseWorld(it.w.uid, it.s);
  });
  $('#choose-save').onclick = () => { closeDrawer(); openChooser({ asked: true }); };
  // You started playing, or another game: show that one, whatever was picked before. (Picking another game
  // while you play keeps it, until you play another.) The list of worlds may come just before or after.
  let playedWorld = null; // the world the live feed last said you play
  function followPlaying() {
    const w = liveFresh() ? store.position.world : null;
    if (w === playedWorld) return;
    playedWorld = w;
    if (w) store.pickedSave = null; // playing: you're where the game says
    if (!w || !store.worlds.has(w) || w === store.view) return;
    store.active = w;
    store.viewPinned = false;
    closeChooser();
    showWorld(w);
    renderWorldPick();
  }

  // ---------- start ----------
  function applyState(s) {
    if ('position' in s) store.serverPosition = store.position = s.position; // first: whether you're playing decides which game shows
    store.trail = s.trail || [];
    if (s.worlds) {
      setWorlds(s.active, s.worlds, { quiet: true });
    } else {
      store.found = new Set(s.found || []);
      store.pins = s.pins || [];
      for (const k of MARK_LISTS) store[k] = new Set(s[k] || []);
    }
    if (s.info) store.info = s.info;
    if (s.info?.version && !seenVersion(s.info.version)) return;
    if (s.world && !s.worlds) applyWorld(s.world);
    LOCS.forEach((l) => paintMarker(l.id));
    applyFilters();
    renderSidebar();
    drawPins();
    drawTrail();
    drawMe();
    updateStatus();
    autoMark();
  }

  function listen() {
    const es = new EventSource('/api/events');
    let dropped = false;
    es.onerror = () => { dropped = true; };
    es.onopen = () => {
      if (!dropped) return;
      dropped = false;
      api('state').then(applyState).catch(() => {});
      api('update').then(applyUpdate).catch(() => {}); // after an update: another version, so the page reloads
    };
    es.addEventListener('position', (e) => {
      store.serverPosition = store.position = JSON.parse(e.data);
      followPlaying();
      refreshPosition();
      drawMe(); drawTrail(); autoMark();
    });
    es.addEventListener('found', (e) => {
      const msg = JSON.parse(e.data);
      const list = Array.isArray(msg) ? msg : msg.found;
      if (!Array.isArray(msg)) {
        const w = store.worlds.get(msg.world);
        if (w) w.found = list;
        if (msg.world !== store.view) return;
      }
      store.found = new Set(list);
      LOCS.forEach((l) => paintMarker(l.id));
      applyFilters();
      renderSidebar();
      renderUnlock(); // a key item picked up live ticks off what it opens straight away
      if (selected) renderDetail();
    });
    // something you just picked up in the game, marked found right there (the 'found' event updates the map)
    es.addEventListener('pickedUp', (e) => {
      const msg = JSON.parse(e.data);
      if (store.view && msg.world !== store.view) return; // no game on screen yet: the map is about to show this one
      const names = msg.ids.map((id) => BY_ID.get(id)).filter(Boolean).map((l) => nice(l.t));
      if (names.length) toast(`Found: ${names.join(', ')}`, { keep: true, ms: 3500 });
    });
    es.addEventListener('pins', (e) => {
      const msg = JSON.parse(e.data);
      const list = Array.isArray(msg) ? msg : msg.pins;
      if (!Array.isArray(msg)) {
        const w = store.worlds.get(msg.world);
        if (w) w.pins = list;
        if (msg.world !== store.view) return;
      }
      store.pins = list;
      if (selected?.kind === 'pin' && document.activeElement?.id === 'pin-label') return renderPinList();
      drawPins();
      if (selected) renderDetail();
    });
    es.addEventListener('worlds', (e) => { const msg = JSON.parse(e.data); setWorlds(msg.active, msg.worlds); });
    es.addEventListener('marks', (e) => {
      const msg = JSON.parse(e.data);
      const w = store.worlds.get(msg.world);
      if (w) w[msg.kind] = msg.ids;
      if (msg.world !== store.view || !MARK_LISTS.includes(msg.kind)) return;
      store[msg.kind] = new Set(msg.ids);
      refreshKnown();
      if (selected) renderDetail();
    });
    es.addEventListener('target', (e) => {
      const msg = JSON.parse(e.data);
      const w = store.worlds.get(msg.world);
      if (w) w.target = msg.target;
      if (msg.world !== store.view) return;
      store.target = msg.target;
      drawGuide();
      if (selected) renderDetail();
    });
    es.addEventListener('update', (e) => applyUpdate(JSON.parse(e.data)));
    es.addEventListener('trail', (e) => { store.trail = JSON.parse(e.data); drawTrail(); autoMark(); });
    es.addEventListener('explored', (e) => {
      const m = JSON.parse(e.data);
      if (m.cells) return addExplored(m.world, m.cells);
      store.explored.set(m.world, bitsFrom(m.bits)); // a reset, or its undo
      if (m.world === store.view) setFogWorld();
    });
    es.addEventListener('exploredUnder', (e) => {
      const m = JSON.parse(e.data);
      if (m.cells) return addExploredUnder(m.world, m.area, m.cells);
      underSets(m.world).set(m.area, bitsFrom(m.bits)); // a reset, or its undo
      if (m.world === store.view) uncoverSoon();
      if (m.world === store.view && caveDrawn?.area.id === m.area) paintCave();
    });
    es.addEventListener('trailAdd', (e) => {
      const p = JSON.parse(e.data);
      store.trail.push(p);
      drawTrail({ added: p });
      autoMark();
    });
  }

  // ---------- updates ----------
  // The map looks for a newer release on GitHub (Updates.cs). Nothing is installed until you press Update: then
  // the map downloads it, checks its SHA-256 and runs its installer once the game is closed (progress is kept).
  const UPDATE_KEY = 'sotf-live-map-update';
  const updateSeen = Object.assign({ later: null, toasted: null, done: null }, readJSON(UPDATE_KEY)); // per device
  const updateBox = $('#update');
  const updateCheck = $('#update-check');
  let update = null;      // GET /api/update
  let pageVersion = null; // the map version this page came from; another one after a restart means: reload

  function seenVersion(v) {
    if (pageVersion && v && v !== pageVersion) { location.reload(); return false; }
    pageVersion = pageVersion || v;
    return true;
  }
  // Release notes are Markdown: headings, lists, bold and code are enough here (everything else stays text).
  // The install steps and the SHA-256 at the end (build\publish.ps1) are for the release page, not for here.
  function notesHtml(md) {
    const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    let html = '';
    let list = false;
    for (const raw of String(md || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (/^#{1,6}\s+install or update/i.test(line)) break;
      if (/^SHA-?256\b/i.test(line)) continue;
      const item = line.match(/^[-*]\s+(.*)$/);
      if (list && !item) { html += '</ul>'; list = false; }
      if (!line) continue;
      const head = line.match(/^#{1,6}\s+(.*)$/);
      if (head) html += `<h3>${inline(head[1])}</h3>`;
      else if (item) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(item[1])}</li>`; }
      else html += `<p>${inline(line)}</p>`;
    }
    return list ? html + '</ul>' : html;
  }
  function renderUpdate() {
    const u = update;
    const busy = u && ['downloading', 'waiting', 'installing'].includes(u.phase);
    const failed = u?.phase === 'failed' || (u?.updated && !u.updated.ok && updateSeen.done !== u.updated.t);
    const latest = u?.latest;
    const show = u && (busy || failed || (latest && updateSeen.later !== latest.version));
    updateBox.hidden = !show;
    updateBox.classList.toggle('failed', !!failed && !busy);
    if (show) {
      const v = latest?.version || u.updated?.to || '';
      let title = `Update ${esc(v)} available`;
      let body = '';
      if (busy) {
        title = `Updating to ${esc(v)}`;
        body = `<p>${esc(u.message || '')}</p>`;
      } else if (u.phase === 'failed') {
        title = 'Update not installed';
        body = `<p>${esc(u.message || '')}</p>`;
      } else if (failed) {
        title = `The update to ${esc(u.updated.to)} didn't finish`;
        body = `<p>Run Install.bat from the release to finish it. What the installer said is in this log:</p><p class="mono">${esc(u.updated.log || '')}</p>`;
      }
      const notes = latest?.notes ? `<details${busy ? '' : ' open'}><summary>What's new</summary><div class="notes">${notesHtml(latest.notes)}</div></details>` : '';
      const canInstall = latest?.installable && !busy;
      const actions = [
        canInstall ? `<button class="primary" data-upd="install">${u.phase === 'failed' ? 'Try again' : 'Update'}</button>` : '',
        latest?.url ? `<a class="secondary" href="${esc(latest.url)}" target="_blank" rel="noopener">Release page</a>` : '',
        busy ? '' : `<button class="secondary" data-upd="later">${failed && !latest ? 'OK' : 'Not now'}</button>`,
      ].join('');
      let hint = '';
      if (canInstall) hint = u.gameRunning
        ? 'Your progress is kept. The game is running: it installs when you close the game, then the map starts again.'
        : 'Your progress is kept. The map closes for a moment and starts again by itself.';
      else if (latest && !latest.installable && !busy) hint = 'Download it from the release page and run Install.bat. Your progress is kept.';
      updateBox.innerHTML = `<h2>${title}</h2>${body}${notes}<div class="update-actions">${actions}</div>${hint ? `<p class="update-hint">${hint}</p>` : ''}`;
    }

    // the version line and the switch, at the bottom of the sidebar
    $('#app-version').textContent = u?.version ? `SOTF Live Map ${u.version}` : 'SOTF Live Map';
    const checked = $('#update-checked');
    const sw = $('#update-switch');
    const note = $('#update-note');
    sw.hidden = !u?.repo;
    note.hidden = !u?.repo;
    if (!u?.repo) { checked.textContent = ''; return; }
    updateCheck.checked = !!u.on;
    updateCheck.disabled = u.prefOff || u.cmdOff;
    let line = '';
    if (u.on && u.checking) line = 'Checking…';
    else if (u.on && u.error) line = `Couldn't reach GitHub${u.checked ? ` (${ago(u.checked)})` : ''}`;
    else if (u.on && u.checked) line = latest ? `${latest.version} available` : `Up to date (checked ${ago(u.checked)})`;
    checked.innerHTML = esc(line) + (u.on && !busy ? ' <button class="text-btn" data-upd="check">Check now</button>' : '') +
      (latest && updateSeen.later === latest.version && !busy ? ' <button class="text-btn" data-upd="show">Show</button>' : '');
    note.textContent = u.cmdOff ? 'Update checks are off (the map was started with --no-update-check).'
      : u.prefOff ? 'Update checks are off in MelonPreferences.cfg (CheckForUpdates under [LiveMap]).'
      : u.on ? `Looks for a new version on GitHub (${u.repo}) at start and every 6 hours. Nothing is installed until you press Update.`
      : 'Off: the map never contacts GitHub.';
  }
  function applyUpdate(u) {
    if (!u || !seenVersion(u.version)) return;
    update = u;
    if (u.updated?.ok && updateSeen.done !== u.updated.t) {
      updateSeen.done = u.updated.t;
      writeJSON(UPDATE_KEY, updateSeen);
      toast(`Updated to SOTF Live Map ${u.updated.to}.`, { ms: 5000 });
    } else if (u.latest && updateSeen.toasted !== u.latest.version && updateSeen.later !== u.latest.version && u.phase === 'idle') {
      updateSeen.toasted = u.latest.version;
      writeJSON(UPDATE_KEY, updateSeen);
      toast(`SOTF Live Map ${u.latest.version} is available.`, { action: 'Details', ms: 8000, onAction: () => { openDrawer(); updateBox.scrollIntoView({ block: 'nearest' }); } });
    }
    renderUpdate();
  }
  async function updateAction(body) {
    try {
      applyUpdate(await api('update', body));
    } catch {
      toast(body.action === 'check' ? "Couldn't check for updates." : body.action === 'install' ? "Couldn't start the update." : "Couldn't save that.");
      api('update').then(applyUpdate).catch(() => {});
    }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-upd]');
    if (!b) return;
    const act = b.dataset.upd;
    if (act === 'install') { b.disabled = true; updateAction({ action: 'install' }); }
    if (act === 'check') updateAction({ action: 'check' });
    if (act === 'later') {
      if (update?.latest) updateSeen.later = update.latest.version;
      if (update?.updated) updateSeen.done = update.updated.t;
      if (update?.phase === 'failed') update.phase = 'idle';
      writeJSON(UPDATE_KEY, updateSeen);
      renderUpdate();
    }
    if (act === 'show') { updateSeen.later = null; writeJSON(UPDATE_KEY, updateSeen); renderUpdate(); updateBox.scrollIntoView({ block: 'nearest' }); }
  });
  updateCheck.onchange = () => updateAction({ action: 'setting', on: updateCheck.checked });
  setInterval(() => { if (update?.repo) renderUpdate(); }, 60000); // keeps "checked 5 min ago" current

  // ---------- welcome (the first time on a device) ----------
  // Three short steps over the map, so what you pick shows straight away: how you want to play (Explore or
  // Guide), how it looks (dark or light, and in Explore how much fog), and where the controls are. Skip, Esc or a swipe down
  // closes it at any step, keeping what you picked. It shows once per device, only when nothing is saved
  // here yet; "Show welcome again" in the side panel brings it back.
  const WELCOME_KEY = 'sotf-live-map-welcome';
  const welcomeEl = $('#welcome');
  const welcomeCard = $('#welcome-card');
  const coachEl = $('#coach');
  const FOG_CHOICES = [['off', 'Off', 0], ['light', 'Light', 35], ['thick', 'Thick', 70], ['full', 'Full', 100]];
  const fogChoice = () => (!prefs.fogOn?.explore ? 'off' : prefs.fog <= 50 ? 'light' : prefs.fog <= 85 ? 'thick' : 'full');
  const welcomeSteps = () => 3;
  function renderWelcome() {
    const verb = canHover ? 'Click' : 'Tap';
    const of = (n) => `<p class="welcome-step">Step ${n} of ${welcomeSteps()}</p>`;
    const live = store.position?.source === 'live' && Date.now() / 1000 - store.position.time < 30;
    const liveLine = live ? '' : '<p class="welcome-note">Your live position appears once you start the game with the mod.</p>';
    welcomeEl.classList.toggle('tour', welcomeStep === 3);
    if (welcomeStep === 1) {
      const n = store.found.size;
      const saves = store.info && !store.info.savesFound || !store.worlds.size
        ? 'Start a game and save once, and the map fills in.'
        : n ? `I found your saves: ${n} place${n === 1 ? ' is' : 's are'} already marked as found or visited.` : 'I found your saves. What you find from now on is marked for you.';
      const card = (mode, title, text, badge) => `<button type="button" class="welcome-option" role="radio" data-welcome-mode="${mode}" aria-checked="${prefs.mode === mode}">
        ${badge ? `<span class="welcome-badge">${badge}</span>` : ''}<strong>${title}</strong><span>${text}</span></button>`;
      welcomeCard.innerHTML = `${of(1)}<h2 id="welcome-title">How do you want to play?</h2>
        <div class="welcome-options" role="radiogroup" aria-label="How you want to play">
          ${card('explore', 'Explore', "Discover it yourself. The map shows where you've been and what you've found. Nothing gets spoiled.", 'Recommended')}
          ${card('guide', 'Guide', 'Show me everything. Every location, with directions. Spoilers included.')}
        </div>
        <p class="welcome-note">${saves}</p>${liveLine}
        <div class="welcome-actions"><button type="button" class="text-btn" data-welcome="skip">Skip</button><button type="button" class="primary" data-welcome="next">Next</button></div>`;
    } else if (welcomeStep === 2) {
      const pick = fogChoice();
      const look = (key, label) => `<button type="button" role="radio" data-welcome-look="${key}" aria-checked="${prefs.darkMap === (key === 'dark')}"><i class="look-swatch ${key}" aria-hidden="true"></i>${label}</button>`;
      welcomeCard.innerHTML = `${of(2)}<h2 id="welcome-title">Make it yours</h2>
        <div class="welcome-row"><h3 id="welcome-look">Look</h3>
          <div class="welcome-chips two" role="radiogroup" aria-labelledby="welcome-look">${look('dark', 'Dark')}${look('light', 'Light')}</div></div>
        ${exploring() ? `<div class="welcome-row"><h3 id="welcome-fog">Fog over what you haven't explored</h3>
          <div class="welcome-chips" role="radiogroup" aria-labelledby="welcome-fog">
          ${FOG_CHOICES.map(([key, label]) => `<button type="button" role="radio" data-welcome-fog="${key}" aria-checked="${pick === key}">${label}</button>`).join('')}
          </div></div>` : ''}
        <p class="welcome-note">You can change ${exploring() ? 'these' : 'this'} any time with the buttons on the right.</p>
        <div class="welcome-actions"><button type="button" class="text-btn" data-welcome="back">Back</button><button type="button" class="text-btn" data-welcome="skip">Skip</button><button type="button" class="primary" data-welcome="next">Next</button></div>`;
    } else if (welcomeStep === 3) {
      welcomeCard.innerHTML = `${of(welcomeSteps())}<h2 id="welcome-title">Quick tour</h2>
        <p class="welcome-note">The controls you'll use most. ${verb} anything on the map for its card.</p>${liveLine}
        <div class="welcome-actions"><button type="button" class="text-btn" data-welcome="back">Back</button><button type="button" class="primary" data-welcome="done">Start playing</button></div>`;
    }
    renderCoach();
  }
  // The tour's notes, each next to the real control it's about.
  function renderCoach() {
    coachEl.hidden = welcomeStep !== 3;
    if (coachEl.hidden) { coachEl.innerHTML = ''; return; }
    const verb = canHover ? 'Click' : 'Tap';
    const notes = [
      { el: '#mode-switch', side: 'below', text: 'Explore or Guide. Switch any time; Guide asks first.' },
      { el: '#follow', side: 'left', text: 'Keeps you in the middle of the map.' },
      { el: '#fog-btn', side: 'left', text: canHover ? 'Fog on or off. Point at it to set how thick.' : 'Fog on or off. Turn it on to set how thick.' },
      { el: '#dark-map', side: 'left', text: "Switch the map's look any time." },
      { el: '#phone-btn', side: 'right', text: 'The map on your phone: scan the code.', pc: true },
      { el: null, side: 'center', text: `${verb} anything for its card: Guide me here puts an arrow in your game (F8 hides it). ${verb} the map to drop a pin.` },
    ].filter((n) => !n.pc || !phoneLayout.matches);
    coachEl.innerHTML = notes.map((n, i) => `<p class="coach-note ${n.side}" data-coach="${i}">${esc(n.text)}</p>`).join('');
    const placed = [];
    notes.forEach((n, i) => {
      const note = coachEl.querySelector(`[data-coach="${i}"]`);
      const box = note.getBoundingClientRect();
      let x;
      let y;
      if (n.el) {
        const target = $(n.el);
        if (target?.closest('#sidebar')) target.scrollIntoView({ block: 'center' }); // the side panel scrolls
        const r = target?.getBoundingClientRect();
        if (!r || !r.width || r.bottom < 0 || r.top > innerHeight) { note.remove(); return; }
        if (n.side === 'left') { x = r.left - box.width - 14; y = r.top + r.height / 2 - box.height / 2; }
        if (n.side === 'right') { x = r.right + 14; y = r.top + r.height / 2 - box.height / 2; }
        if (n.side === 'below') { x = r.left + r.width / 2 - box.width / 2; y = r.bottom + 14; }
      } else {
        const m = mapEl.getBoundingClientRect();
        x = m.left + m.width / 2 - box.width / 2;
        y = m.top + m.height * (phoneLayout.matches ? 0.56 : 0.42) - box.height / 2; // on a phone, below the buttons' notes
      }
      x = Math.max(8, Math.min(innerWidth - box.width - 8, x));
      y = Math.max(8, Math.min(innerHeight - box.height - 8, y));
      for (const p of placed) {
        if (x < p.x + p.w && p.x < x + box.width && y < p.y + p.h + 6 && p.y < y + box.height + 6) y = p.y + p.h + 6;
      }
      placed.push({ x, y, w: box.width, h: box.height });
      note.style.left = `${Math.round(x)}px`;
      note.style.top = `${Math.round(y)}px`;
    });
  }
  function openWelcome() {
    if (draft) endDraft();
    if (selected) closeDetail();
    if (!fogMenu.hidden) openFogMenu(false);
    welcomeStep = 1;
    welcomeEl.hidden = false;
    renderWelcome();
    welcomeCard.querySelector('[aria-checked="true"]')?.focus();
  }
  function closeWelcome() {
    welcomeStep = 0;
    welcomeEl.hidden = true;
    renderCoach();
    try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* storage blocked: it may show again */ }
    savePrefs(); // from now on this device has settings, so the welcome doesn't come back by itself
    if (heldToast) { const [msg, opts] = heldToast; heldToast = null; toast(msg, opts); }
    if (unchosen()) openChooser();
  }
  function welcomeGo(step) {
    welcomeStep = step;
    renderWelcome();
    welcomeCard.querySelector('.primary')?.focus();
  }
  welcomeCard.addEventListener('click', (e) => {
    const mode = e.target.closest('[data-welcome-mode]')?.dataset.welcomeMode;
    if (mode) { setMode(mode, { quiet: true }); return renderWelcome(); }
    const look = e.target.closest('[data-welcome-look]')?.dataset.welcomeLook;
    if (look) {
      prefs.darkMap = look === 'dark';
      savePrefs();
      applyDarkMap();
      return renderWelcome();
    }
    const fog = FOG_CHOICES.find(([key]) => key === e.target.closest('[data-welcome-fog]')?.dataset.welcomeFog);
    if (fog) {
      if (fog[2]) { prefs.fog = fog[2]; setFogOn(true); } else setFogOn(false);
      return renderWelcome();
    }
    const act = e.target.closest('[data-welcome]')?.dataset.welcome;
    if (act === 'next') welcomeGo(welcomeStep + 1);
    if (act === 'back') welcomeGo(welcomeStep - 1);
    if (act === 'skip' || act === 'done') closeWelcome();
  });
  // arrow keys move between the options of a step, like any radio group
  welcomeCard.addEventListener('keydown', (e) => {
    const group = e.target.closest('[role="radiogroup"]');
    if (!group || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const items = [...group.querySelectorAll('[role="radio"]')];
    const next = items[(items.indexOf(e.target) + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length];
    e.preventDefault();
    next.click();
    group.querySelectorAll('[role="radio"]')[items.indexOf(next)]?.focus();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && welcomeStep) { e.stopImmediatePropagation(); closeWelcome(); } }, true);
  let swipeFrom = null; // on a phone, a swipe down on the sheet closes it
  welcomeCard.addEventListener('touchstart', (e) => { swipeFrom = e.touches[0] && { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
  welcomeCard.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    if (swipeFrom && t && t.clientY - swipeFrom.y > 90 && Math.abs(t.clientX - swipeFrom.x) < 60) closeWelcome();
    swipeFrom = null;
  });
  window.addEventListener('resize', () => { if (welcomeStep === 3) renderCoach(); });
  onFoundChange = () => { if (welcomeStep === 1) renderWelcome(); }; // your saves fill in the count a moment after opening
  $('#welcome-again').onclick = () => { closeDrawer(); openWelcome(); };
  function maybeWelcome() {
    let seen = false;
    try { seen = !!localStorage.getItem(WELCOME_KEY); } catch { /* storage blocked */ }
    if (firstVisit && !seen) openWelcome();
  }

  renderSidebar();
  api('state')
    .then((s) => {
      store.online = true;
      applyState(s);
      api('update').then(applyUpdate).catch(() => {});
      // around you, about 1.2 km across the screen's short side (a phone at the zoom a PC opens at would show
      // only a few hundred metres); the cave view zooms itself
      const short = Math.min(map.getSize().x, map.getSize().y);
      // (at once: an animated zoom shows the trail's canvas stretched until it's drawn again)
      if (store.position && !cave && !unchosen()) map.setView([store.position.y, store.position.x], Math.min(-1, Math.round(Math.log2(short / 1200) * 2) / 2), { animate: false });
      listen();
    })
    .catch(() => {
      store.online = false;
      applyState(readJSON(LOCAL_KEY));
    })
    .then(maybeWelcome);
})();
