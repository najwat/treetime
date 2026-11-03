/* TreeTime: plain JS, no build step.
   Look and behavior follow DESIGN.md and reference/prototype.html. */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------
  const CONFIG = {
    layerUrl: 'https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/SDOT_Trees_CDL/FeatureServer/0',
    statusField: 'CURRENT_STATUS',
    statusValue: 'INSVC',

    // Field names are matched against the layer's own metadata at startup.
    fields: {
      common:     { candidates: ['COMMON_NAME', 'COMMONNAME'], pattern: /common/i },
      scientific: { candidates: ['SCIENTIFIC_NAME', 'SCIENTIFIC'], pattern: /scien|botan/i },
      diameter:   { candidates: ['DIAM', 'DBH', 'DIAMETER'], pattern: /diam|dbh/i },
      address:    { candidates: ['UNITDESC', 'ADDRESS'], pattern: /addr/i },
      planted:    { candidates: ['PLANTED_DATE', 'PLANTDATE'], pattern: /plant.*date/i },
      unitId:     { candidates: ['UNITID'], pattern: null }, // stable tree ID, used for favorites
    },

    maxDiameter: 80,    // inches; larger values are data-entry errors -> "Not recorded"
    sliderMax: 72,      // top slider stop means "72 and larger"
    areaLimit: 3000,    // above this many matches in view, ask the user to zoom in
    listTop: 12,        // species shown before "Show all"
    detailZoom: 16,     // MapLibre zoom (512px tiles) for jumping to one tree
    boundaryUrl: 'data/seattle-boundary.geojson?v=20261103',
    // Bounding box of the boundary file, used for the very first frame.
    cityBox: [[-122.43578, 47.49554], [-122.23598, 47.73416]],

  };

  // Tree families, grouped by genus (the first word of the scientific name).
  // Real botanical groups only; any genus not listed is "Everything else".
  const FAMS = [
    { id: 'maple',   name: 'Maples',           g: ['Acer'] },
    { id: 'cherry',  name: 'Cherries & plums', g: ['Prunus'] },
    { id: 'pear',    name: 'Pears & apples',   g: ['Pyrus', 'Malus'] },
    { id: 'oak',     name: 'Oaks',             g: ['Quercus'] },
    { id: 'ash',     name: 'Ashes',            g: ['Fraxinus'] },
    { id: 'birch',   name: 'Birches',          g: ['Betula'] },
    { id: 'conifer', name: 'Conifers',         g: ['Thuja', 'Juniperus', 'Chamaecyparis', 'Cedrus', 'Pinus', 'Picea', 'Abies', 'Tsuga',
                                                 'Sequoia', 'Sequoiadendron', 'Metasequoia', 'Cupressus', 'Pseudotsuga', 'Calocedrus',
                                                 'Cryptomeria', 'Larix', 'Taxodium', 'Taxus'] },
    { id: 'other',   name: 'Everything else',  g: [] },
  ];
  const OTHER = FAMS.length - 1;
  // Plain-word nouns for the filter pill: [singular, plural].
  const NOUNS = {
    maple: ['maple', 'maples'], cherry: ['cherry or plum', 'cherries & plums'], pear: ['pear or apple', 'pears & apples'],
    oak: ['oak', 'oaks'], ash: ['ash', 'ashes'], birch: ['birch', 'birches'], conifer: ['conifer', 'conifers'],
    other: ['other tree', 'other trees'],
  };
  const famOfGenus = {};
  FAMS.forEach((f, i) => f.g.forEach((g) => { famOfGenus[g] = i; }));

  const SIZES = [
    { n: 'Young',  r: [0, 5],   l: '<6″' },
    { n: 'Medium', r: [6, 17],  l: '6–17″' },
    { n: 'Mature', r: [18, 35], l: '18–35″' },
    { n: 'Large',  r: [36, 49], l: '36–49″' },
    { n: 'Giant',  r: [50, CONFIG.sliderMax], l: '50″+' },
  ];

  // ---------------------------------------------------------------------------
  // State & helpers
  // ---------------------------------------------------------------------------
  const state = {
    f: {}, oid: 'OBJECTID', maxRec: 2000,
    fams: new Set(FAMS.map((_, i) => i)),
    dmin: 0, dmax: CONFIG.sliderMax,
    sp: null,
    favOnly: false,       // show only saved trees
    sel: null,            // selected feature
    total: null,          // all in-service trees
    match: null,          // trees matching current filters
  };
  let speciesRows = [];   // [{name, count}] for current family/size filters
  const speciesInfo = new Map(); // common name -> {sci, fam}

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat('en-US');
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sql = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const attr = (a, name) => {
    if (!name) return undefined;
    if (name in a) return a[name];
    const k = Object.keys(a).find((x) => x.toUpperCase() === name.toUpperCase());
    return k ? a[k] : undefined;
  };

  function genusOf(sci) {
    if (!sci) return '';
    const parts = String(sci).trim().split(/\s+/);
    return (parts[0] === 'x' || parts[0] === '×') ? (parts[1] || '') : parts[0];
  }
  const famOfSci = (sci) => famOfGenus[genusOf(sci)] ?? OTHER;

  // Recorded diameter in inches, or null when missing / zero / implausibly large.
  function diamOf(a) {
    const d = Number(attr(a, state.f.diameter));
    return d > 0 && d <= CONFIG.maxDiameter ? d : null;
  }
  const fmtIn = (d) => (Number.isInteger(d) ? String(d) : d.toFixed(1));

  // ---------------------------------------------------------------------------
  // ArcGIS REST
  // ---------------------------------------------------------------------------
  async function arcgis(path, params, signal) {
    const qs = new URLSearchParams({ f: 'json', ...params });
    const url = `${CONFIG.layerUrl}${path}`;
    // Long where clauses (e.g. "Everything else") go as a form POST, which
    // ArcGIS accepts for queries and which avoids URL length limits.
    const res = qs.toString().length > 1800
      ? await fetch(url, { method: 'POST', body: qs, signal })
      : await fetch(`${url}?${qs}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Query failed');
    return data;
  }
  const query = (params, signal) => arcgis('/query', params, signal);

  // Fetch every page of a query (features or grouped statistics).
  async function queryAll(params, signal, cap = Infinity) {
    const out = [];
    for (;;) {
      const p = out.length ? { ...params, resultOffset: String(out.length) } : params;
      const r = await query(p, signal);
      const feats = r.features || [];
      out.push(...feats);
      if (!r.exceededTransferLimit || !feats.length || out.length >= cap) return out;
    }
  }

  const ctl = {};
  function fresh(key) {
    ctl[key]?.abort();
    ctl[key] = new AbortController();
    return ctl[key].signal;
  }

  function resolveFields(fields) {
    const byName = new Map(fields.map((f) => [f.name.toUpperCase(), f]));
    const out = {};
    for (const [key, spec] of Object.entries(CONFIG.fields)) {
      let hit = spec.candidates.map((c) => byName.get(c.toUpperCase())).find(Boolean);
      if (!hit && spec.pattern) hit = fields.find((f) => spec.pattern.test(f.name) || spec.pattern.test(f.alias || ''));
      if (hit) out[key] = hit.name;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Where clause
  // ---------------------------------------------------------------------------
  const sizeActive = () => state.dmin > 0 || state.dmax < CONFIG.sliderMax;
  const allFams = () => state.fams.size === FAMS.length;

  function genusClause(g) {
    const S = state.f.scientific;
    return `${S} = ${sql(g)} OR ${S} LIKE ${sql(g + ' %')}`;
  }
  function famClause(i) {
    if (i !== OTHER) return `(${FAMS[i].g.map(genusClause).join(' OR ')})`;
    const known = FAMS.flatMap((f) => f.g).map(genusClause).join(' OR ');
    return `(${state.f.scientific} IS NULL OR NOT (${known}))`;
  }

  function buildWhere({ species = true } = {}) {
    const { diameter: D, common: C } = state.f;
    const p = [`${CONFIG.statusField} = ${sql(CONFIG.statusValue)}`];
    if (!allFams() && state.f.scientific) p.push(`(${[...state.fams].map(famClause).join(' OR ')})`);
    if (sizeActive() && D) {
      // Size filters only consider trees with a recorded, plausible diameter.
      p.push(`${D} > 0`, `${D} <= ${CONFIG.maxDiameter}`);
      if (state.dmin > 0) p.push(`${D} >= ${state.dmin}`);
      if (state.dmax < CONFIG.sliderMax) p.push(`${D} < ${state.dmax + 1}`);
    }
    if (species && state.sp && C) p.push(`${C} = ${sql(state.sp)}`);
    return p.join(' AND ');
  }

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------
  const root = document.documentElement;
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => root.dataset.theme === 'dark' || (root.dataset.theme !== 'light' && darkMq.matches);
  let famColors = [], ink = '#1d2a22', muted = '#5d6b62';
  function readColors() {
    const c = getComputedStyle(root);
    famColors = FAMS.map((f) => c.getPropertyValue('--f-' + f.id).trim());
    ink = c.getPropertyValue('--ink').trim();
    muted = c.getPropertyValue('--muted').trim();
  }
  readColors();

  // ---------------------------------------------------------------------------
  // Basemap: OpenFreeMap vector tiles drawn by MapLibre GL. Each theme starts
  // from an OpenFreeMap style and is recolored so the basemap recedes and the
  // trees stand out. Colors follow DESIGN.md.
  // ---------------------------------------------------------------------------
  const BASEMAPS = {
    light: {
      style: 'https://tiles.openfreemap.org/styles/positron',
      ground: '#f4f6f1', minor: '#ffffff', major: '#ffffff', casing: '#e2e7de', rail: '#e2e7de', path: '#e2e7de',
      building: '#ebefe8', park: '#e5eee1', water: '#dce7ea', boundary: '#d3dacf',
      label: '#8a958d', halo: '#ffffff', roadLabelMinZoom: null,
    },
    dark: {
      style: 'https://tiles.openfreemap.org/styles/dark',
      ground: '#0f1411', minor: '#1a221d', major: '#243029', casing: null, rail: '#1a221d', path: '#161d19',
      building: '#141a16', park: '#122019', water: '#0d1517', boundary: '#243029',
      label: '#7d8a81', halo: '#0f1411', roadLabelMinZoom: 15,
    },
  };
  const BUILDING_MIN_ZOOM = 16;
  const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>';
  const themeName = () => (isDark() ? 'dark' : 'light');

  // Add `extra` px to a line-width value: a number, or a zoom interpolate/step.
  function widen(w, extra) {
    if (typeof w === 'number') return w + extra;
    if (Array.isArray(w) && (w[0] === 'interpolate' || w[0] === 'step')) {
      const out = w.slice();
      const first = w[0] === 'interpolate' ? 4 : 3; // index of the first output value
      for (let k = first; k < out.length; k += 2) if (typeof out[k] === 'number') out[k] += extra;
      if (w[0] === 'step' && typeof out[2] === 'number') out[2] += extra;
      return out;
    }
    return w;
  }

  // Recolor an OpenFreeMap style (OpenMapTiles schema) with a palette.
  // Layers are matched by source-layer and type, so this also works if
  // OpenFreeMap renames or adds layers.
  function themeStyle(src, p) {
    const style = JSON.parse(JSON.stringify(src));
    for (const k of Object.keys(style.sources || {})) style.sources[k].attribution = '';
    const out = [];
    for (const lyr of style.layers) {
      const sl = lyr['source-layer'] || '';
      const id = lyr.id;
      lyr.paint = lyr.paint || {};
      lyr.layout = lyr.layout || {};
      const hide = () => { lyr.layout.visibility = 'none'; };
      const fill = (c) => { lyr.paint = { 'fill-color': c, 'fill-opacity': 1, 'fill-antialias': true }; };
      if (lyr.type === 'background') lyr.paint = { 'background-color': p.ground };
      else if (lyr.type === 'raster' || lyr.type === 'hillshade' || lyr.type === 'fill-extrusion' || lyr.type === 'heatmap') hide();
      else if (lyr.type === 'symbol') {
        if (/shield/.test(id) || lyr.layout['icon-image'] && !lyr.layout['text-field']) { hide(); }
        else {
          lyr.paint = { 'text-color': p.label, 'text-halo-color': p.halo, 'text-halo-width': 1.2, 'text-halo-blur': 0, 'icon-opacity': 0.5 };
          if (sl === 'transportation_name' && p.roadLabelMinZoom) lyr.minzoom = Math.max(lyr.minzoom || 0, p.roadLabelMinZoom);
        }
      } else if (sl === 'water') { if (lyr.type === 'fill') fill(p.water); else lyr.paint = { 'line-color': p.water, 'line-width': lyr.paint['line-width'] ?? 1 }; }
      else if (sl === 'waterway') { if (lyr.type === 'line') lyr.paint = { 'line-color': p.water, 'line-width': lyr.paint['line-width'] ?? 1 }; else hide(); }
      else if (sl === 'park' || (sl === 'landcover' && /wood|grass|park|forest|scrub/.test(id))) { if (lyr.type === 'fill') fill(p.park); else hide(); }
      else if (sl === 'landuse' || sl === 'landcover') hide();
      else if (sl === 'building') { if (lyr.type === 'fill') { fill(p.building); lyr.minzoom = Math.max(lyr.minzoom || 0, BUILDING_MIN_ZOOM); } else hide(); }
      else if (sl === 'boundary') { lyr.paint['line-color'] = p.boundary; lyr.paint['line-opacity'] = 1; }
      else if (sl === 'transportation' || sl === 'aeroway') {
        if (lyr.type === 'fill') fill(p.minor);
        else if (lyr.type === 'line') {
          const major = /motorway|major|trunk|primary|secondary|tertiary|runway/.test(id);
          let color = major ? p.major : p.minor;
          if (/casing/.test(id)) { if (!p.casing) { hide(); out.push(lyr); continue; } color = p.casing; }
          else if (/rail/.test(id)) color = p.rail;
          else if (/path|footway|pier|cycle|steps/.test(id)) {
            // Footpaths and sidewalks: thin and close to the ground so they don't compete with trees.
            color = p.path;
            lyr.paint['line-width'] = ['interpolate', ['linear'], ['zoom'], 15, 0.5, 18, 1.5, 20, 2.5];
          }
          lyr.paint['line-color'] = color;
          lyr.paint['line-opacity'] = 1;
          delete lyr.paint['line-pattern'];
        } else hide();
      } else if (lyr.type === 'fill') hide();
      else if (lyr.type === 'line') { lyr.paint['line-color'] = p.minor; }
      out.push(lyr);
    }
    // Light theme: minor streets get the same thin casing as major ones.
    if (p.casing) {
      const k = out.findIndex((lyr) => lyr.id === 'highway_minor');
      if (k >= 0) {
        const c = JSON.parse(JSON.stringify(out[k]));
        c.id = 'highway_minor_casing';
        c.paint = { 'line-color': p.casing, 'line-width': widen(out[k].paint['line-width'] ?? 1, 1.5), 'line-opacity': 1 };
        out.splice(k, 0, c);
      }
    }
    // Labels go on top, in their original order. The tree layer is inserted just
    // below the first label, so this keeps every road, path and building under
    // the dots even if a style puts some labels early in its stack.
    style.layers = [...out.filter((lyr) => lyr.type !== 'symbol'), ...out.filter((lyr) => lyr.type === 'symbol')];
    return style;
  }

  const blankStyle = (p) => ({ version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': p.ground } }] });

  const styleCache = {};
  function basemapStyle(name) {
    const p = BASEMAPS[name];
    styleCache[name] ??= fetch(p.style)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((json) => themeStyle(json, p))
      .catch((e) => { console.warn('[trees] basemap unavailable, showing trees only:', e.message); delete styleCache[name]; return blankStyle(p); });
    return styleCache[name];
  }

  // ---------------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------------
  // Room around the city in the whole-city view: clear of the result pill (top)
  // and the zoom buttons (right); tighter on phones.
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
  let sheetPeek = 172; // measured once the sheet is laid out
  const fitPadding = () => (isPhone()
    ? { top: 56, bottom: sheetPeek + 16, left: 16, right: 58 }
    : { top: 64, bottom: 40, left: 48, right: 72 });

  const map = new maplibregl.Map({
    container: 'map',
    style: blankStyle(BASEMAPS[themeName()]),
    bounds: CONFIG.cityBox,
    fitBoundsOptions: { padding: fitPadding() },
    maxZoom: 20,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: ATTRIBUTION }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');

  let shownTheme = null;
  async function applyBasemap() {
    const name = themeName();
    const style = await basemapStyle(name);
    if (name !== themeName() || name === shownTheme) return;
    shownTheme = name;
    map.setStyle(style, { diff: false });
  }

  // ---------------------------------------------------------------------------
  // Seattle boundary: whole-city fit, zoom/pan limits, and an inverse mask that
  // dims everything outside the city. The boundary is a local file.
  // ---------------------------------------------------------------------------
  const EMPTY = { type: 'FeatureCollection', features: [] };
  let cityBox = CONFIG.cityBox;
  let cityGeo = null;
  let maskGeo = null;
  let userMoved = false;
  map.on('movestart', (e) => { if (e.originalEvent) userMoved = true; });

  const maskPaint = () => ({ 'fill-color': BASEMAPS[themeName()].ground, 'fill-opacity': isDark() ? 0.8 : 0.75, 'fill-antialias': false });
  const linePaint = () => ({ 'line-color': muted, 'line-opacity': 0.5, 'line-width': 1 });

  function bboxOf(geo) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const f of geo.features) {
      const g = f.geometry;
      for (const poly of g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]) {
        for (const [x, y] of poly[0]) { w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y); }
      }
    }
    return [[w, s], [e, n]];
  }

  // A world-sized polygon with each part of the city cut out as a hole.
  function makeMask(geo) {
    const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
    const sign = (r) => { let a = 0; for (let k = 0; k < r.length - 1; k++) a += r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1]; return Math.sign(a); };
    const holes = [];
    for (const f of geo.features) {
      const g = f.geometry;
      for (const poly of g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]) {
        holes.push(sign(poly[0]) === sign(world) ? poly[0].slice().reverse() : poly[0]);
      }
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, ...holes] } };
  }

  const cityCamera = () => map.cameraForBounds(cityBox, { padding: fitPadding() });
  function fitCity(animate) {
    const c = cityCamera();
    if (!c) return;
    if (animate) map.easeTo({ ...c, duration: 450 });
    else map.jumpTo(c);
  }

  // Limits. minZoom is the whole-city view. Panning is held to the city's box
  // plus ~10%, at every zoom:
  //  - zoomed in (view smaller than the box): the view can't go past the box;
  //  - zoomed out (view larger than the box): the box can't leave the view.
  // A fixed maxBounds can't do both: MapLibre keeps the whole viewport inside it,
  // so a box sized for the city would block the whole-city view on wide screens,
  // and one sized for that view would allow panning far past the city when
  // zoomed in. A transform constraint applies the rule per zoom instead.
  let cityMinZoom = 0;
  const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
  const mercLat = (y) => (360 / Math.PI) * Math.atan(Math.exp(Math.PI * (1 - 2 * y))) - 90;
  const clampAxis = (c, lo, hi, half) => (hi - lo >= 2 * half
    ? Math.min(Math.max(c, lo + half), hi - half)      // view inside the box
    : Math.min(Math.max(c, hi - half), lo + half));    // box inside the view

  function constrainView(lngLat, zoom) {
    const z = Math.max(zoom ?? cityMinZoom, cityMinZoom);
    const el = map.getContainer();
    const world = 512 * 2 ** z;
    const [[w, s], [e, n]] = cityBox;
    const dx = (e - w) * 0.1, dy = (n - s) * 0.1;
    const lng = clampAxis(lngLat.lng, w - dx, e + dx, (el.clientWidth / 2 / world) * 360);
    // latitude in Web Mercator units so the clamp is exact in screen space
    const y = clampAxis(mercY(lngLat.lat), mercY(n + dy), mercY(s - dy), el.clientHeight / 2 / world);
    return { center: new maplibregl.LngLat(lng, mercLat(y)), zoom: z };
  }

  function applyLimits() {
    const c = cityCamera();
    if (!c) return;
    cityMinZoom = Math.max(0, c.zoom - 0.01);
    map.setMinZoom(cityMinZoom);
    map.setTransformConstrain(constrainView);
  }

  fetch(CONFIG.boundaryUrl)
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((geo) => {
      cityGeo = geo;
      cityBox = bboxOf(geo);
      maskGeo = makeMask(geo);
      map.getSource('city-mask')?.setData(maskGeo);
      map.getSource('city-line')?.setData(cityGeo);
      applyLimits();
      if (!userMoved) fitCity(false);
    })
    .catch((e) => { console.warn('[trees] city boundary unavailable:', e.message); applyLimits(); });

  // Trees: one GeoJSON source and a circle layer, placed above roads and
  // buildings but under the first label layer so street names stay readable.
  let treeFeats = [];            // features currently drawn, indexed by `i`
  let treeData = { type: 'FeatureCollection', features: [] };
  const canHover = window.matchMedia('(hover: hover)').matches;

  // Base dot radius ~2–8px by trunk diameter; the layer scales it down when zoomed out.
  const baseRadius = (d) => (d ? Math.min(8, Math.max(2, 1.2 + Math.sqrt(d) * 0.75)) : 2);
  // Zoom must be the outermost expression, so any offset goes inside each stop.
  const zoomRadius = (r, add = 0) => ['interpolate', ['linear'], ['zoom'],
    12, ['+', ['*', r, 0.45], add], 13, ['+', ['*', r, 0.55], add], 16, ['+', r, add]];

  function treePaint() {
    const ground = BASEMAPS[themeName()].ground;
    const color = ['match', ['get', 'fam']];
    famColors.forEach((c, k) => color.push(k, c));
    color.push(famColors[OTHER]);
    return {
      'circle-radius': zoomRadius(['get', 'r']),
      'circle-color': color,
      'circle-opacity': 0.85,
      'circle-stroke-width': 1,
      'circle-stroke-color': ground,
      'circle-stroke-opacity': 1,
    };
  }

  function firstLabelLayer() {
    return map.getStyle().layers.find((lyr) => lyr.type === 'symbol')?.id;
  }

  // Order above the basemap: city mask, city line, trees, selection ring,
  // then the style's labels (moved to the top by themeStyle).
  function addTreeLayers() {
    const before = firstLabelLayer();
    map.addSource('city-mask', { type: 'geojson', data: maskGeo || EMPTY });
    map.addLayer({ id: 'city-mask', type: 'fill', source: 'city-mask', paint: maskPaint() }, before);
    map.addSource('city-line', { type: 'geojson', data: cityGeo || EMPTY });
    map.addLayer({ id: 'city-line', type: 'line', source: 'city-line', layout: { 'line-join': 'round' }, paint: linePaint() }, before);
    map.addSource('trees', { type: 'geojson', data: treeData });
    map.addLayer({ id: 'trees', type: 'circle', source: 'trees', layout: { 'circle-sort-key': ['-', 0, ['get', 'd']] }, paint: treePaint() }, before);
    map.addSource('tree-selected', { type: 'geojson', data: selData() });
    map.addLayer({
      id: 'tree-selected', type: 'circle', source: 'tree-selected',
      paint: { 'circle-radius': zoomRadius(['get', 'r'], 4), 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 2, 'circle-stroke-color': ink },
    }, before);
  }
  map.on('style.load', addTreeLayers);

  function drawTrees(feats) {
    treeFeats = feats.filter((ft) => ft.geometry && ft.geometry.x != null);
    treeData = {
      type: 'FeatureCollection',
      features: treeFeats.map((ft, i) => {
        const d = diamOf(ft.attributes);
        return {
          type: 'Feature', id: i,
          geometry: { type: 'Point', coordinates: [ft.geometry.x, ft.geometry.y] },
          properties: { i, fam: famOfSci(attr(ft.attributes, state.f.scientific)), d: d || 0, r: baseRadius(d) },
        };
      }),
    };
    map.getSource('trees')?.setData(treeData);
  }

  function selData() {
    const ft = state.sel;
    if (!ft) return { type: 'FeatureCollection', features: [] };
    return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [ft.geometry.x, ft.geometry.y] }, properties: { r: baseRadius(diamOf(ft.attributes)) } }] };
  }
  const updateSelLayer = () => map.getSource('tree-selected')?.setData(selData());

  // Recolor dots (family colors, halo) for the current theme.
  function restyle() {
    if (map.getLayer('city-mask')) {
      const m = maskPaint(), l = linePaint();
      for (const k of Object.keys(m)) map.setPaintProperty('city-mask', k, m[k]);
      for (const k of Object.keys(l)) map.setPaintProperty('city-line', k, l[k]);
    }
    if (!map.getLayer('trees')) return;
    const p = treePaint();
    map.setPaintProperty('trees', 'circle-color', p['circle-color']);
    map.setPaintProperty('trees', 'circle-stroke-color', p['circle-stroke-color']);
    map.setPaintProperty('tree-selected', 'circle-stroke-color', ink);
  }

  // Hit-testing with a few pixels of slack, nearest dot wins.
  function treeAt(point, slack = 4) {
    if (!map.getLayer('trees')) return null;
    const hits = map.queryRenderedFeatures([[point.x - slack, point.y - slack], [point.x + slack, point.y + slack]], { layers: ['trees'] });
    let best = null, bd = Infinity;
    for (const h of hits) {
      const q = map.project(h.geometry.coordinates);
      const dd = (q.x - point.x) ** 2 + (q.y - point.y) ** 2;
      if (dd < bd) { bd = dd; best = h; }
    }
    return best ? treeFeats[best.properties.i] : null;
  }

  const tip = $('tip');
  if (canHover) {
    map.on('mousemove', (e) => {
      const ft = treeAt(e.point, 3);
      map.getCanvas().style.cursor = ft ? 'pointer' : '';
      if (!ft) { tip.hidden = true; return; }
      const d = diamOf(ft.attributes);
      tip.textContent = `${attr(ft.attributes, state.f.common) || 'Unknown species'} · ${d ? fmtIn(d) + '″' : 'diameter not recorded'}`;
      const q = map.project([ft.geometry.x, ft.geometry.y]);
      tip.style.left = `${q.x}px`;
      tip.style.top = `${q.y - 8}px`;
      tip.hidden = false;
    });
    map.on('mouseout', () => { tip.hidden = true; });
    map.on('movestart', () => { tip.hidden = true; });
  }

  // Map status: what the view loader last reported. The pill at the top of the
  // map shows either this message or a plain-words summary of active filters.
  let viewMsg = null; // null | {kind: 'loading'|'zoom'|'empty'|'error', text}
  function setViewMsg(kind, text) {
    viewMsg = kind ? { kind, text } : null;
    renderPill();
  }

  // The visible area clipped to the city's bounding box, or null if the view is
  // entirely outside it (then no trees are requested).
  function envelope() {
    const b = map.getBounds();
    const [[w, s], [e, n]] = cityBox;
    const xmin = Math.max(b.getWest(), w), ymin = Math.max(b.getSouth(), s);
    const xmax = Math.min(b.getEast(), e), ymax = Math.min(b.getNorth(), n);
    if (xmin >= xmax || ymin >= ymax) return null;
    return {
      geometry: JSON.stringify({ xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
    };
  }

  const outFields = () => [state.oid, ...new Set(Object.values(state.f))].join(',');

  // Load the matching trees inside the visible map area.
  let ready = false; // set once the layer's fields are known
  async function loadView() {
    if (!ready) return;
    const signal = fresh('view');
    if (state.favOnly) {
      // Favorites are stored locally: no requests needed.
      const favs = favMatches();
      drawTrees(favs.map(favFeature));
      setViewMsg(null);
      if (state.sel && !favs.some((f) => f.key === treeKey(state.sel.attributes))) select(null);
      return;
    }
    const where = buildWhere();
    const env = envelope();
    if (!env) { drawTrees([]); setViewMsg(null); return; }
    const slow = setTimeout(() => setViewMsg('loading', 'Loading trees…'), 400);
    try {
      const { count } = await query({ where, ...env, returnCountOnly: 'true' }, signal);
      if (count > CONFIG.areaLimit) {
        drawTrees([]);
        setViewMsg('zoom', 'Zoom in to see individual trees');
        return;
      }
      const feats = count ? await queryAll({
        where, ...env,
        outFields: outFields(),
        returnGeometry: 'true',
        outSR: '4326',
        orderByFields: state.oid,
        resultRecordCount: String(state.maxRec),
      }, signal, CONFIG.areaLimit) : [];
      drawTrees(feats);
      if (count) setViewMsg(null);
      else setViewMsg('empty', filtersActive() ? 'No matching trees in this area' : 'No trees in this area');

      // Close the card if the selected tree is in view but no longer matches.
      if (state.sel) {
        const id = attr(state.sel.attributes, state.oid);
        const g = state.sel.geometry;
        const inView = map.getBounds().contains([g.x, g.y]);
        if (inView && !feats.some((ft) => attr(ft.attributes, state.oid) === id)) select(null);
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      setViewMsg('error', "Couldn't load trees for this area. Move the map to try again.");
    } finally {
      clearTimeout(slow);
    }
  }

  let viewTimer;
  map.on('moveend', () => { clearTimeout(viewTimer); viewTimer = setTimeout(loadView, 300); });

  $('zin').onclick = () => map.zoomIn();
  $('zout').onclick = () => map.zoomOut();
  $('zfit').onclick = () => fitCity(true);
  new ResizeObserver(() => { map.resize(); applyLimits(); }).observe($('main'));

  // ---------------------------------------------------------------------------
  // Detail card
  // ---------------------------------------------------------------------------
  function select(ft) {
    state.sel = ft || null;
    updateSelLayer();
    const card = $('card');
    if (!ft) { card.hidden = true; return; }

    const a = ft.attributes;
    const { y: lat, x: lng } = ft.geometry;
    const d = diamOf(a);
    const sci = attr(a, state.f.scientific);
    const addr = attr(a, state.f.address);
    const planted = attr(a, state.f.planted);
    const rows = [
      ['Trunk', d ? `${fmtIn(d)} in (${Math.round(d * 2.54)} cm)` : 'Not recorded'],
      ['Family', FAMS[famOfSci(sci)].name],
    ];
    if (addr) rows.push(['Address', addr]);
    if (typeof planted === 'number') rows.push(['Planted', new Date(planted).toLocaleDateString(undefined, { timeZone: 'UTC' })]);
    rows.push(['Location', `${lat.toFixed(5)}, ${lng.toFixed(5)}`]);

    if (editingName) { cancelName = true; editingName = false; nameInput.hidden = true; $('cname').hidden = false; }
    $('cname').textContent = attr(a, state.f.common) || 'Unknown species';
    $('cgen').textContent = sci || 'Scientific name not recorded';
    $('cdl').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('clink').href = `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lng.toFixed(5)}`;
    card.hidden = false;
    updateSaveButton();
  }
  $('cardx').onclick = () => select(null);
  map.on('click', (e) => {
    if (e.originalEvent?.target?.closest?.('.fav-pin')) return; // handled by the star
    select(treeAt(e.point, 6));
  });

  // ---------------------------------------------------------------------------
  // Favorites: saved in this browser (localStorage), shown in the sidebar and
  // as stars on the map regardless of filters.
  // ---------------------------------------------------------------------------
  const FAV_KEY = 'favoriteTrees';
  // [{key: 'id:<UNITID>', a: attributes, g: {x, y}, savedAt, since, name, gone}], newest first.
  // `since` = when the tree was first saved; `name` = nickname ('' if none);
  // `gone` = no longer in the city's in-service inventory (checked on load).
  let favorites = [];
  try { favorites = JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { favorites = []; }
  if (!Array.isArray(favorites)) favorites = [];
  // Recover trees saved by the short-lived "crushes" version, which moved
  // favorites to another key. Keeps its data so nothing is lost either way.
  try {
    const moved = JSON.parse(localStorage.getItem('treetimeCrushes') || '[]');
    if (Array.isArray(moved)) {
      for (const c of moved) {
        if (c && c.on !== false && c.key && c.a && c.g && !favorites.some((f) => f.key === c.key)) {
          favorites.push({ key: c.key, a: c.a, g: c.g, savedAt: c.addedAt || c.since || Date.now() });
        }
      }
      favorites.sort((x, y) => y.savedAt - x.savedAt);
      if (moved.length) localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
    }
  } catch (e) { /* storage unavailable */ }
  // Normalize: key every record by the city's tree ID (UNITID), never OBJECTID,
  // and fill in `since` / `name`. Duplicates keep the earliest date and any name.
  (function migrateFavorites() {
    const byKey = new Map();
    for (const f of favorites) {
      if (!f || !f.a || !f.g) continue;
      const uid = attr(f.a, 'UNITID');
      const key = uid ? `id:${uid}` : f.key;
      const rec = { ...f, key, since: f.since ?? f.savedAt ?? Date.now(), savedAt: f.savedAt ?? f.since ?? Date.now(), name: typeof f.name === 'string' ? f.name : '' };
      const prev = byKey.get(key);
      if (!prev) byKey.set(key, rec);
      else byKey.set(key, { ...prev, since: Math.min(prev.since, rec.since), name: prev.name || rec.name });
    }
    const before = JSON.stringify(favorites);
    favorites = [...byKey.values()].sort((x, y) => y.savedAt - x.savedAt);
    if (JSON.stringify(favorites) !== before) { try { localStorage.setItem(FAV_KEY, JSON.stringify(favorites)); } catch (e) { /* ignore */ } }
  })();
  let favMarkers = [];

  function treeKey(a) {
    const id = attr(a, state.f.unitId || 'UNITID');
    return id ? `id:${id}` : `oid:${attr(a, state.oid)}`;
  }
  const recordFor = (ft) => (ft ? favorites.find((f) => f.key === treeKey(ft.attributes)) : null);
  const isFav = (ft) => !!recordFor(ft);
  const nickname = (f) => (f && f.name) || '';
  const speciesOf = (a) => attr(a, state.f.common) || 'Unknown species';
  const monthYear = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  function saveFavorites() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favorites)); } catch (e) { /* storage unavailable: kept for this visit */ }
  }

  function toggleFavorite(ft) {
    const key = treeKey(ft.attributes);
    if (favorites.some((f) => f.key === key)) favorites = favorites.filter((f) => f.key !== key);
    else addFavorite(ft);
    saveFavorites();
    favoritesChanged();
  }

  function addFavorite(ft, name = '') {
    const now = Date.now();
    const rec = { key: treeKey(ft.attributes), a: ft.attributes, g: { x: ft.geometry.x, y: ft.geometry.y }, savedAt: now, since: now, name };
    favorites.unshift(rec);
    return rec;
  }

  function favoritesChanged() {
    renderFavorites();
    if (state.favOnly) {
      if (!favorites.length) state.favOnly = false;
      changed({ species: false });
    }
  }

  const favFeature = (f) => ({ attributes: f.a, geometry: f.g });

  // Same rules as buildWhere(), applied to the locally stored favorites.
  function favMatches() {
    return favorites.filter((f) => {
      const a = f.a;
      if (!state.fams.has(famOfSci(attr(a, state.f.scientific)))) return false;
      if (sizeActive()) {
        const d = diamOf(a);
        if (!d || d < state.dmin) return false;
        if (state.dmax < CONFIG.sliderMax && d >= state.dmax + 1) return false;
      }
      if (state.sp && attr(a, state.f.common) !== state.sp) return false;
      return true;
    });
  }

  $('savedonly').onchange = (e) => { state.favOnly = e.target.checked; changed({ species: false }); };

  function openFavorite(f) {
    if (isPhone()) setSheet('collapsed');
    map.flyTo({ center: [f.g.x, f.g.y], zoom: Math.max(map.getZoom(), CONFIG.detailZoom), duration: 900, essential: true });
    select(favFeature(f));
  }

  function renderFavorites() {
    // Sidebar list
    $('savedcount').textContent = favorites.length ? fmt.format(favorites.length) : '';
    $('savedonlywrap').hidden = !favorites.length;
    $('savedonly').checked = state.favOnly;
    const list = $('favs');
    list.innerHTML = '';
    if (!favorites.length) {
      list.innerHTML = '<div class="empty"><p><b>No saved trees yet.</b></p><p>Tap any dot on the map to open its card, then tap <b>☆ Save</b>. Saved trees show up here and as ★ on the map.</p></div>';
    }
    for (const f of favorites) {
      const a = f.a;
      const d = diamOf(a);
      const fam = famOfSci(attr(a, state.f.scientific));
      const row = document.createElement('div');
      row.className = 'fav';
      row.style.setProperty('--c', `var(--f-${FAMS[fam].id})`);
      const name = nickname(f);
      const size = d ? `${fmtIn(d)}″` : null;
      const sub = (name ? [speciesOf(a), size, attr(a, state.f.address)] : [attr(a, state.f.address), size]).filter(Boolean).join(' · ');
      row.classList.toggle('is-gone', !!f.gone);
      row.innerHTML = `<button type="button" class="fav-open"><i></i><span><b></b><small></small><em class="gone-note" hidden>No longer in the city’s inventory</em></span></button>
        <button type="button" class="fav-x" aria-label="Remove from saved">×</button>`;
      row.querySelector('b').textContent = name || speciesOf(a);
      row.querySelector('small').textContent = sub;
      row.querySelector('.gone-note').hidden = !f.gone;
      row.querySelector('.fav-x').setAttribute('aria-label', `Remove ${name || speciesOf(a)} from saved`);
      row.querySelector('.fav-open').onclick = () => openFavorite(f);
      row.querySelector('.fav-x').onclick = () => {
        favorites = favorites.filter((x) => x.key !== f.key);
        saveFavorites();
        favoritesChanged();
      };
      list.appendChild(row);
    }

    // Map stars
    favMarkers.forEach((m) => m.remove());
    favMarkers = favorites.map((f) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'fav-pin';
      el.textContent = '★';
      el.title = nickname(f) || speciesOf(f.a);
      el.setAttribute('aria-label', `Saved tree: ${el.title}`);
      el.addEventListener('click', (e) => { e.stopPropagation(); select(favFeature(f)); });
      return new maplibregl.Marker({ element: el }).setLngLat([f.g.x, f.g.y]).addTo(map);
    });

    // Nickname labels under the dot (shown from zoom 17 via CSS on the map container)
    nameMarkers.forEach((m) => m.remove());
    nameMarkers = favorites.filter((f) => nickname(f)).map((f) => {
      const el = document.createElement('div');
      el.className = 'tree-label';
      el.textContent = f.name;
      return new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, 9] }).setLngLat([f.g.x, f.g.y]).addTo(map);
    });
    updateLabelZoom();

    // Card button, heading, "Saved since"
    updateSaveButton();
  }

  let nameMarkers = [];
  const LABEL_MIN_ZOOM = 17;
  function updateLabelZoom() { map.getContainer().classList.toggle('labels-on', map.getZoom() >= LABEL_MIN_ZOOM); }
  map.on('zoom', updateLabelZoom);

  function updateSaveButton() {
    const b = $('cfav');
    const rec = recordFor(state.sel);
    const on = !!rec;
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '★ Saved' : '☆ Save';
    b.title = on ? 'Remove from saved trees' : 'Save this tree';
    if (!state.sel) return;
    const a = state.sel.attributes;
    const d = diamOf(a);
    const name = nickname(rec);
    if (!editingName) $('cname').textContent = name || speciesOf(a);
    $('cspecies').textContent = [speciesOf(a), d ? `${fmtIn(d)}″` : null].filter(Boolean).join(' · ');
    $('cspecies').hidden = !name;
    $('csince').textContent = on ? `Saved since ${monthYear(rec.since)}` : '';
    $('csince').hidden = !on;
    $('cgone').hidden = !rec?.gone;
    const pen = $('cnamebtn');
    pen.title = name ? 'Rename this tree' : 'Name this tree';
    pen.setAttribute('aria-label', pen.title);
  }
  $('cfav').onclick = () => { if (state.sel) toggleFavorite(state.sel); };

  // Nicknames: inline field in place of the heading. Enter or blur saves,
  // Escape cancels. Naming also saves the tree; clearing the name keeps it saved.
  const NAME_MAX = 30; // characters (code points, so an emoji counts as one)
  let editingName = false, cancelName = false;
  const nameInput = $('cnameinput');
  function startNaming() {
    if (!state.sel) return;
    editingName = true;
    cancelName = false;
    nameInput.value = nickname(recordFor(state.sel));
    $('cname').hidden = true;
    nameInput.hidden = false;
    nameInput.focus();
    nameInput.select();
  }
  function endNaming(save) {
    if (!editingName) return;
    editingName = false;
    nameInput.hidden = true;
    $('cname').hidden = false;
    if (save && state.sel) {
      const v = Array.from(nameInput.value.trim()).slice(0, NAME_MAX).join('');
      let rec = recordFor(state.sel);
      if (v || rec) {
        if (!rec) rec = addFavorite(state.sel);
        rec.name = v;
        saveFavorites();
        favoritesChanged();
        return;
      }
    }
    updateSaveButton();
  }
  $('cnamebtn').onclick = startNaming;
  nameInput.addEventListener('input', () => {
    const chars = Array.from(nameInput.value);
    if (chars.length > NAME_MAX) nameInput.value = chars.slice(0, NAME_MAX).join('');
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); endNaming(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelName = true; endNaming(false); }
  });
  nameInput.addEventListener('blur', () => { if (!cancelName) endNaming(true); });

  // On load, mark saved trees that are no longer in the city's in-service
  // inventory. They keep their last known details and can still be removed.
  async function checkInventory() {
    const U = state.f.unitId;
    if (!U) return;
    const ids = favorites.map((f) => attr(f.a, U)).filter(Boolean);
    if (!ids.length) return;
    const present = new Set();
    try {
      for (let k = 0; k < ids.length; k += 100) {
        const chunk = ids.slice(k, k + 100);
        const r = await query({
          where: `${CONFIG.statusField} = ${sql(CONFIG.statusValue)} AND ${U} IN (${chunk.map(sql).join(',')})`,
          outFields: U, returnGeometry: 'false', resultRecordCount: String(chunk.length),
        });
        for (const ft of r.features || []) present.add(attr(ft.attributes, U));
      }
    } catch (e) { return; } // can't tell right now: leave records as they are
    let dirty = false;
    for (const f of favorites) {
      const id = attr(f.a, U);
      if (!id) continue;
      const gone = !present.has(id);
      if (!!f.gone !== gone) { f.gone = gone; dirty = true; }
    }
    if (dirty) { saveFavorites(); renderFavorites(); }
  }

  // ---------------------------------------------------------------------------
  // Sidebar: count, family chips, size presets, slider, species list
  // ---------------------------------------------------------------------------
  const filtersActive = () => !allFams() || sizeActive() || !!state.sp || state.favOnly;

  function sizeText() {
    if (!sizeActive()) return null;
    const { dmin, dmax } = state;
    if (dmax >= CONFIG.sliderMax) return `${dmin}″+`;
    if (dmin === 0) return `under ${dmax + 1}″`;
    return `${dmin}–${dmax}″`;
  }

  // Family names as separate pieces so a line can wrap between them.
  function familyPieces() {
    const ids = [...state.fams].sort((a, b) => a - b);
    if (allFams()) return null;
    if (ids.length <= 2) return ids.map((i) => FAMS[i].name);
    return [`${ids.length} families`];
  }

  // Plain-words summary as parts, e.g. ["1,204 maples", ["18–35″"]]; each part is a
  // list of pieces that must not break internally.
  function describeFilters() {
    const n = state.favOnly ? favMatches().length : state.match;
    const one = n === 1;
    let noun = one ? 'tree' : 'trees';
    let famShown = false;
    if (state.favOnly) noun = one ? 'saved tree' : 'saved trees';
    else if (!state.sp && state.fams.size === 1) { noun = NOUNS[FAMS[[...state.fams][0]].id][one ? 0 : 1]; famShown = true; }
    const parts = [[`${n == null ? '…' : fmt.format(n)} ${noun}`]];
    if (state.sp) parts.push([state.sp]);
    else if (!famShown && familyPieces()) parts.push(familyPieces());
    if (sizeText()) parts.push([sizeText()]);
    return parts;
  }

  // Each piece is a no-wrap span; a "·" belongs to the piece after it, so a
  // line never starts with a separator.
  function partsHtml(parts) {
    return parts.map((pieces, i) => pieces.map((pc, j) => {
      const lead = j > 0 ? '' : i > 0 ? '<span class="sep" aria-hidden="true">·</span> ' : '';
      const tail = j < pieces.length - 1 ? ',' : '';
      return `<span class="chunk">${lead}${esc(pc)}${tail}</span>`;
    }).join(' ')).join(' ');
  }

  function renderPill() {
    const pill = $('pill');
    const active = filtersActive();
    let html = null;
    let clear = false;
    const msg = (t) => `<span class="chunk-wrap">${esc(t)}</span>`;
    if (viewMsg && (viewMsg.kind === 'zoom' || viewMsg.kind === 'error')) html = msg(viewMsg.text);
    else if (active) { html = viewMsg?.kind === 'empty' ? msg(viewMsg.text) : partsHtml(describeFilters()); clear = true; }
    else if (viewMsg) html = msg(viewMsg.text);
    pill.hidden = !html;
    $('pilltext').innerHTML = html || '';
    $('pillclearwrap').hidden = !clear;
    $('pillclear').textContent = state.favOnly && allFams() && !sizeActive() && !state.sp ? 'Clear' : 'Clear filters';
  }

  function clearFilters() {
    state.fams = new Set(FAMS.map((_, i) => i));
    state.dmin = 0;
    state.dmax = CONFIG.sliderMax;
    $('dmin').value = state.dmin;
    $('dmax').value = state.dmax;
    state.sp = null;
    state.favOnly = false;
    customOpen = false;
    changed();
  }
  $('pillclear').onclick = clearFilters;

  const famsEl = $('fams');
  function buildChips(counts) {
    famsEl.innerHTML = '';
    FAMS.forEach((f, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.style.setProperty('--c', `var(--f-${f.id})`);
      b.innerHTML = `<i></i>${esc(f.name)} <small>${fmt.format(counts[i])}</small>`;
      b.onclick = () => {
        if (allFams()) state.fams = new Set([i]);
        else if (state.fams.has(i)) {
          state.fams.delete(i);
          if (!state.fams.size) state.fams = new Set(FAMS.map((_, j) => j));
        } else state.fams.add(i);
        state.sp = null;
        changed();
      };
      famsEl.appendChild(b);
    });
  }
  $('allfam').hidden = false;
  $('allfam').onclick = () => { state.fams = new Set(FAMS.map((_, i) => i)); state.sp = null; changed(); };

  const sizesEl = $('sizes');
  SIZES.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${s.n}<small>${s.l}</small>`;
    b.onclick = () => {
      if (state.dmin === s.r[0] && state.dmax === s.r[1]) { state.dmin = 0; state.dmax = CONFIG.sliderMax; }
      else { state.dmin = s.r[0]; state.dmax = s.r[1]; }
      $('dmin').value = state.dmin;
      $('dmax').value = state.dmax;
      changed();
    };
    s.el = b;
    sizesEl.appendChild(b);
  });
  $('dmin').oninput = (e) => { state.dmin = Math.min(+e.target.value, state.dmax); e.target.value = state.dmin; changed(); };
  $('dmax').oninput = (e) => { state.dmax = Math.max(+e.target.value, state.dmin); e.target.value = state.dmax; changed(); };

  function renderControls() {
    [...famsEl.children].forEach((b, i) => b.setAttribute('aria-pressed', state.fams.has(i) ? 'true' : 'false'));
    SIZES.forEach((s) => {
      const on = state.dmin === s.r[0] && state.dmax === s.r[1];
      s.el.classList.toggle('on', on);
      s.el.setAttribute('aria-pressed', String(on));
    });
    const max = CONFIG.sliderMax;
    $('rangeout').textContent = sizeActive() ? `${state.dmin}–${state.dmax >= max ? max + '+' : state.dmax} in` : 'Any size';
    $('fill').style.left = `${(state.dmin / max) * 100}%`;
    $('fill').style.width = `${((state.dmax - state.dmin) / max) * 100}%`;
    // The slider stays open while a custom (non-preset) range is set.
    const custom = sizeActive() && !SIZES.some((sz) => state.dmin === sz.r[0] && state.dmax === sz.r[1]);
    const open = customOpen || custom;
    $('custom').hidden = !open;
    $('customtoggle').setAttribute('aria-expanded', String(open));
    $('customtoggle').classList.toggle('on', open);
    syncSearch();
  }
  let customOpen = false;
  $('customtoggle').onclick = () => {
    const custom = sizeActive() && !SIZES.some((sz) => state.dmin === sz.r[0] && state.dmax === sz.r[1]);
    if (custom && customOpen === false) return; // can't hide the slider while it holds the only record of the range
    customOpen = !customOpen;
    renderControls();
  };

  // ---------------------------------------------------------------------------
  // Species search: a combobox that is the species filter. Typing suggests
  // matching species (with counts for the current filters); empty + focused
  // shows the five most common species in the current map view.
  // ---------------------------------------------------------------------------
  const qEl = $('q'), sugEl = $('suggest');
  let sugItems = [];        // [{name, count}] or null while loading
  let sugMode = 'match';    // 'match' | 'view'
  let sugActive = -1;
  let viewTop = { key: '', rows: null };

  const speciesColor = (name) => `var(--f-${FAMS[speciesInfo.get(name)?.fam ?? OTHER].id})`;

  function syncSearch() {
    if (document.activeElement !== qEl) qEl.value = state.sp || '';
    $('qclear').hidden = !qEl.value && !state.sp;
  }

  function renderSuggest() {
    const head = sugMode === 'view' ? '<p class="suggest-head">Most common in this view</p>' : '';
    let body;
    if (sugItems === null) body = '<p class="suggest-empty">Loading…</p>';
    else if (!sugItems.length) body = `<p class="suggest-empty">${sugMode === 'view' ? 'No trees in this view.' : 'No species match.'}</p>`;
    else {
      body = sugItems.map((r, k) => `<div class="opt" role="option" id="sug-${k}" data-k="${k}" aria-selected="${k === sugActive}">
        <i style="--c:${speciesColor(r.name)}"></i><span>${esc(r.name)}</span><em>${fmt.format(r.count)}</em></div>`).join('');
    }
    sugEl.innerHTML = head + body;
    qEl.setAttribute('aria-activedescendant', sugActive >= 0 ? `sug-${sugActive}` : '');
    sugEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  function openSuggest() { sugEl.hidden = false; qEl.setAttribute('aria-expanded', 'true'); }
  function closeSuggest() { sugEl.hidden = true; qEl.setAttribute('aria-expanded', 'false'); sugActive = -1; }

  async function loadViewTop() {
    const env = envelope();
    const C = state.f.common;
    if (!env || !C) { sugItems = []; renderSuggest(); return; }
    const where = `${buildWhere({ species: false })} AND ${C} IS NOT NULL`;
    const key = where + env.geometry;
    if (viewTop.key === key && viewTop.rows) { sugItems = viewTop.rows; sugActive = -1; renderSuggest(); return; }
    sugItems = null; renderSuggest();
    const signal = fresh('viewtop');
    try {
      const r = await query({
        where, ...env,
        groupByFieldsForStatistics: C,
        outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: state.oid, outStatisticFieldName: 'n' }]),
        orderByFields: 'n DESC',
        resultRecordCount: '5',
      }, signal);
      const rows = (r.features || []).map((ft) => ({ name: attr(ft.attributes, C), count: attr(ft.attributes, 'n') }))
        .filter((x) => x.name && String(x.name).trim()).slice(0, 5);
      viewTop = { key, rows };
      if (sugMode === 'view') { sugItems = rows; sugActive = -1; renderSuggest(); }
    } catch (e) {
      if (e.name !== 'AbortError' && sugMode === 'view') { sugItems = []; renderSuggest(); }
    }
  }

  function updateSuggest() {
    const t = qEl.value.trim().toLowerCase();
    if (!t || qEl.value === state.sp) {
      sugMode = 'view';
      loadViewTop();
    } else {
      sugMode = 'match';
      sugItems = speciesRows
        .filter((r) => `${r.name} ${speciesInfo.get(r.name)?.sci || ''}`.toLowerCase().includes(t))
        .slice(0, 8);
      sugActive = sugItems.length ? 0 : -1;
      renderSuggest();
    }
    openSuggest();
  }

  function pickSpecies(name) {
    state.sp = name;
    closeSuggest();
    qEl.value = name;
    qEl.blur();
    changed({ species: false });
  }

  qEl.addEventListener('focus', () => {
    if (isPhone()) setSheet('expanded');
    if (qEl.value === state.sp) qEl.select();
    updateSuggest();
  });
  qEl.addEventListener('input', () => {
    $('qclear').hidden = !qEl.value && !state.sp;
    if (!qEl.value && state.sp) { state.sp = null; changed({ species: false }); }
    updateSuggest();
  });
  qEl.addEventListener('keydown', (e) => {
    const n = sugItems?.length || 0;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (sugEl.hidden) updateSuggest(); else if (n) { sugActive = (sugActive + 1) % n; renderSuggest(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { sugActive = (sugActive - 1 + n) % n; renderSuggest(); } }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = sugItems?.[sugActive >= 0 ? sugActive : 0];
      if (pick) pickSpecies(pick.name);
    } else if (e.key === 'Escape') { closeSuggest(); qEl.value = state.sp || ''; qEl.blur(); }
  });
  qEl.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement === qEl) return;
      closeSuggest();
      qEl.value = state.sp || '';
      $('qclear').hidden = !state.sp;
    }, 0);
  });
  sugEl.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus so the click lands
  sugEl.addEventListener('click', (e) => {
    const opt = e.target.closest('.opt');
    if (opt) pickSpecies(sugItems[+opt.dataset.k].name);
  });
  $('qclear').onclick = () => {
    const had = !!state.sp;
    state.sp = null;
    qEl.value = '';
    $('qclear').hidden = true;
    if (had) changed({ species: false });
    qEl.focus();
  };

  // ---------------------------------------------------------------------------
  // Data refresh
  // ---------------------------------------------------------------------------
  async function loadCount() {
    const signal = fresh('count');
    state.match = null;
    renderPill();
    if (state.favOnly) return; // the pill counts favorites locally
    try {
      const noFilters = allFams() && !sizeActive() && !state.sp;
      state.match = noFilters && state.total != null
        ? state.total
        : (await query({ where: buildWhere(), returnCountOnly: 'true' }, signal)).count;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
    renderPill();
  }

  async function loadSpecies() {
    const signal = fresh('species');
    const C = state.f.common;
    if (!C) return;
    try {
      const feats = await queryAll({
        where: `${buildWhere({ species: false })} AND ${C} IS NOT NULL`,
        groupByFieldsForStatistics: C,
        outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: state.oid, outStatisticFieldName: 'n' }]),
        orderByFields: 'n DESC',
      }, signal);
      speciesRows = feats
        .map((ft) => ({ name: attr(ft.attributes, C), count: attr(ft.attributes, 'n') }))
        .filter((r) => r.name && String(r.name).trim());
      if (!sugEl.hidden && sugMode === 'match') updateSuggest();
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }

  let refreshTimer;
  function changed({ species = true } = {}) {
    renderControls();
    renderFavorites();
    renderPill();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      loadCount();
      if (species) loadSpecies();
      loadView();
    }, 250);
  }

  // Theme switches recolor the dots and swap the basemap.
  function onTheme() {
    readColors();
    restyle();        // dots switch right away
    applyBasemap();   // basemap swaps when its style is ready; tree layers are re-added on style.load
  }
  darkMq.addEventListener?.('change', onTheme);

  // Theme button: cycles System → Light → Dark. System = no data-theme.
  const THEMES = ['system', 'light', 'dark'];
  const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' };
  const THEME_ICON = {
    system: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor"/></svg>',
    light: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></g></svg>',
    dark: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z" fill="currentColor"/></svg>',
  };
  const themeChoice = () => (root.dataset.theme === 'light' || root.dataset.theme === 'dark' ? root.dataset.theme : 'system');
  function renderThemeBtn() {
    const cur = themeChoice();
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    const label = `Theme: ${THEME_LABEL[cur]}. Switch to ${THEME_LABEL[next]}`;
    const b = $('themebtn');
    b.innerHTML = THEME_ICON[cur];
    b.title = label;
    b.setAttribute('aria-label', label);
  }
  $('themebtn').onclick = () => {
    const next = THEMES[(THEMES.indexOf(themeChoice()) + 1) % THEMES.length];
    if (next === 'system') delete root.dataset.theme;
    else root.dataset.theme = next;
    try {
      if (next === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', next);
    } catch (e) { /* storage unavailable: the choice lasts for this visit */ }
    renderThemeBtn();
  };
  renderThemeBtn();

  // About dialog
  const about = $('about');
  $('aboutbtn').onclick = () => about.showModal();
  about.addEventListener('click', (e) => { if (e.target === about) about.close(); }); // click on the backdrop

  // Tabs: Explore / Saved. The last tab is remembered.
  const TABS = ['explore', 'saved'];
  function setTab(name, focus = false) {
    for (const t of TABS) {
      const on = t === name;
      const tab = $(`tab-${t}`);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $(`panel-${t}`).hidden = !on;
      if (on && focus) tab.focus();
    }
    try { localStorage.setItem('tab', name); } catch (e) { /* ignore */ }
    if (isPhone()) requestAnimationFrame(() => setSheet(sheetState, false));
  }
  for (const t of TABS) $(`tab-${t}`).onclick = () => setTab(t);
  $('tab-explore').parentElement.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const cur = TABS.findIndex((t) => $(`tab-${t}`).getAttribute('aria-selected') === 'true');
    setTab(TABS[(cur + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length], true);
  });

  // ---------------------------------------------------------------------------
  // Phones: the sidebar is a draggable bottom sheet over a full-screen map.
  // Collapsed it shows the header, the tab bar and the first control of the
  // active tab (the search field on Explore).
  // ---------------------------------------------------------------------------
  const sheet = $('sheet');
  let sheetState = 'collapsed';
  const sheetFull = () => sheet.getBoundingClientRect().height;
  function measurePeek() {
    const top = sheet.getBoundingClientRect().top;
    const panel = TABS.map((t) => $(`panel-${t}`)).find((p) => !p.hidden);
    const first = panel?.firstElementChild;
    const bottom = (first && !first.hidden ? first : $('tab-explore').parentElement).getBoundingClientRect().bottom;
    return Math.round(Math.min(bottom - top + 14, sheetFull()));
  }
  function setSheet(stateName, animate = true) {
    if (!isPhone()) { sheet.style.transform = ''; root.style.removeProperty('--sheet-visible'); return; }
    sheetState = stateName;
    sheetPeek = measurePeek();
    const offset = stateName === 'expanded' ? 0 : sheetFull() - sheetPeek;
    sheet.classList.toggle('animate', animate);
    sheet.style.transform = `translateY(${offset}px)`;
    sheet.dataset.state = stateName;
    $('grab').setAttribute('aria-label', stateName === 'expanded' ? 'Collapse panel' : 'Expand panel');
    root.style.setProperty('--sheet-visible', `${stateName === 'expanded' ? sheetFull() : sheetPeek}px`);
  }

  // Drag from the grab handle, header or tab bar; tap the handle to toggle.
  let drag = null;
  sheet.addEventListener('pointerdown', (e) => {
    if (!isPhone() || !e.target.closest('.grab, .hdr, .tabs')) return;
    const m = /translateY\((-?[\d.]+)px\)/.exec(sheet.style.transform);
    drag = { y: e.clientY, start: m ? +m[1] : 0, moved: false, t: performance.now(), id: e.pointerId };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 6) return;
    drag.moved = true;
    sheet.classList.remove('animate');
    const max = sheetFull() - sheetPeek;
    sheet.style.transform = `translateY(${Math.min(max, Math.max(0, drag.start + dy))}px)`;
  });
  window.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved) { if (e.target.closest('.grab')) setSheet(sheetState === 'expanded' ? 'collapsed' : 'expanded'); return; }
    sheet.dataset.justDragged = '1'; // swallow the click that follows a drag
    setTimeout(() => delete sheet.dataset.justDragged, 0);
    const dy = e.clientY - d.y, v = dy / Math.max(1, performance.now() - d.t); // px per ms
    const max = sheetFull() - sheetPeek, pos = Math.min(max, Math.max(0, d.start + dy));
    setSheet(v < -0.35 || (v <= 0.35 && pos < max / 2) ? 'expanded' : 'collapsed');
  });
  // A drag that ends on a tab shouldn't also switch tabs.
  sheet.addEventListener('click', (e) => { if (sheet.dataset.justDragged) { e.stopPropagation(); e.preventDefault(); } }, true);
  window.matchMedia('(max-width: 760px)').addEventListener?.('change', () => setSheet('collapsed', false));
  window.addEventListener('resize', () => { if (isPhone()) setSheet(sheetState, false); });

  new MutationObserver(onTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------
  async function init() {
    renderControls();
    let meta;
    try {
      meta = await arcgis('', {});
    } catch (e) {
      setViewMsg('error', "Couldn't reach the city's tree data. Try reloading.");
      return;
    }
    state.f = resolveFields(meta.fields || []);
    state.oid = meta.objectIdField || (meta.fields || []).find((f) => f.type === 'esriFieldTypeOID')?.name || 'OBJECTID';
    state.maxRec = meta.maxRecordCount || 2000;
    console.info('[trees] resolved fields', state.f);
    ready = true;

    const base = `${CONFIG.statusField} = ${sql(CONFIG.statusValue)}`;
    const C = state.f.common, S = state.f.scientific, D = state.f.diameter;
    const groupBy = [C, S].filter(Boolean);

    const [groups, largest] = await Promise.all([
      groupBy.length ? queryAll({
        where: base,
        groupByFieldsForStatistics: groupBy.join(','),
        outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: state.oid, outStatisticFieldName: 'n' }]),
        orderByFields: 'n DESC',
      }).catch(() => []) : [],
      D ? query({
        where: `${base} AND ${D} > 0 AND ${D} <= ${CONFIG.maxDiameter}`,
        outFields: outFields(),
        returnGeometry: 'true',
        outSR: '4326',
        orderByFields: `${D} DESC`,
        resultRecordCount: '1',
      }).then((r) => r.features?.[0]).catch(() => null) : null,
    ]);

    // Totals, family counts, and each species' most common scientific name.
    const famCounts = FAMS.map(() => 0);
    const bySpecies = new Map();
    let total = 0;
    for (const ft of groups) {
      const a = ft.attributes;
      const n = Number(attr(a, 'n')) || 0;
      const name = C ? attr(a, C) : null;
      const sci = S ? attr(a, S) : null;
      total += n;
      famCounts[famOfSci(sci)] += n;
      if (name && String(name).trim()) {
        const s = bySpecies.get(name) || { count: 0, best: 0, sci: null };
        s.count += n;
        if (n > s.best) { s.best = n; s.sci = sci; }
        bySpecies.set(name, s);
      }
    }
    for (const [name, s] of bySpecies) speciesInfo.set(name, { sci: s.sci, fam: famOfSci(s.sci) });

    if (groups.length) {
      state.total = state.match = total;
      speciesRows = [...bySpecies].map(([name, s]) => ({ name, count: s.count })).sort((a, b) => b.count - a.count);
    } else {
      loadCount().then(() => { state.total = state.match; });
      loadSpecies();
    }
    if (S) buildChips(famCounts);
    else famsEl.closest('.field').hidden = true;
    renderControls();
    renderPill();
    renderFavorites();
    checkInventory();

    // Open on the whole city. On wider screens, also open the largest recorded
    // tree's card; on phones it would cover half the city, so it stays closed.
    if (largest?.geometry && !window.matchMedia('(max-width: 760px)').matches) select(largest);
    loadView();
  }

  let initialTab = 'explore';
  try { if (TABS.includes(localStorage.getItem('tab'))) initialTab = localStorage.getItem('tab'); } catch (e) { /* ignore */ }
  setTab(initialTab);
  setSheet('collapsed', false);
  applyBasemap();
  init();
})();
