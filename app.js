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
    home: { center: [47.6145, -122.3360], zoom: 11 }, // MapLibre zoom (512px tiles)
    detailZoom: 16,

  };

  // Tree families, grouped by genus (the first word of the scientific name).
  // The first eight follow the prototype. "Flowering trees" and "Shade trees"
  // keep common Seattle genera out of "Everything else"; both mean "other
  // flowering / shade trees", since cherries, maples, oaks etc. have their own chips.
  const FAMS = [
    { id: 'maple',     name: 'Maples',           g: ['Acer'] },
    { id: 'cherry',    name: 'Cherries & plums', g: ['Prunus'] },
    { id: 'pear',      name: 'Pears & apples',   g: ['Pyrus', 'Malus'] },
    { id: 'flowering', name: 'Flowering trees',  g: ['Cornus', 'Crataegus', 'Magnolia', 'Amelanchier', 'Styrax', 'Cercis', 'Lagerstroemia',
                                                     'Syringa', 'Halesia', 'Stewartia', 'Koelreuteria', 'Sorbus', 'Arbutus', 'Chionanthus',
                                                     'Oxydendrum', 'Davidia', 'Laburnum', 'Cladrastis', 'Albizia', 'Franklinia', 'Heptacodium',
                                                     'Cotinus', 'Cydonia', 'Mespilus', 'Prunus-x'] },
    { id: 'ash',       name: 'Ashes',            g: ['Fraxinus'] },
    { id: 'birch',     name: 'Birches',          g: ['Betula'] },
    { id: 'oak',       name: 'Oaks',             g: ['Quercus'] },
    { id: 'shade',     name: 'Shade trees',      g: ['Platanus', 'Tilia', 'Liquidambar', 'Ulmus', 'Gleditsia', 'Zelkova', 'Carpinus', 'Aesculus',
                                                     'Fagus', 'Celtis', 'Liriodendron', 'Cercidiphyllum', 'Nyssa', 'Parrotia', 'Robinia', 'Ginkgo',
                                                     'Gymnocladus', 'Catalpa', 'Juglans', 'Ostrya', 'Populus', 'Salix', 'Alnus', 'Styphnolobium',
                                                     'Sophora', 'Corylus', 'Pterocarya', 'Phellodendron', 'Sassafras', 'Morus', 'Eucommia', 'Ailanthus'] },
    { id: 'conifer',   name: 'Conifers',         g: ['Thuja', 'Juniperus', 'Chamaecyparis', 'Cedrus', 'Pinus', 'Picea', 'Abies', 'Tsuga',
                                                     'Sequoia', 'Sequoiadendron', 'Metasequoia', 'Cupressus', 'Pseudotsuga', 'Calocedrus',
                                                     'Cryptomeria', 'Larix', 'Taxodium', 'Taxus'] },
    { id: 'other',     name: 'Everything else',  g: [] },
  ];
  const OTHER = FAMS.length - 1;
  // Plain-word nouns for the filter pill: [singular, plural].
  const NOUNS = {
    maple: ['maple', 'maples'], cherry: ['cherry or plum', 'cherries & plums'], pear: ['pear or apple', 'pears & apples'],
    flowering: ['flowering tree', 'flowering trees'], ash: ['ash', 'ashes'], birch: ['birch', 'birches'], oak: ['oak', 'oaks'],
    shade: ['shade tree', 'shade trees'], conifer: ['conifer', 'conifers'], other: ['other tree', 'other trees'],
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
    sp: null, q: '', showAll: false,
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
  let famColors = [], ink = '#1d2a22';
  function readColors() {
    const c = getComputedStyle(root);
    famColors = FAMS.map((f) => c.getPropertyValue('--f-' + f.id).trim());
    ink = c.getPropertyValue('--ink').trim();
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
      ground: '#f4f6f1', minor: '#ffffff', major: '#ffffff', casing: '#e2e7de', rail: '#e2e7de',
      building: '#ebefe8', park: '#e5eee1', water: '#dce7ea', boundary: '#d3dacf',
      label: '#8a958d', halo: '#ffffff', roadLabelMinZoom: null,
    },
    dark: {
      style: 'https://tiles.openfreemap.org/styles/dark',
      ground: '#0f1411', minor: '#1a221d', major: '#243029', casing: null, rail: '#1a221d',
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
    style.layers = out;
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
  const lngLat = ([lat, lng]) => [lng, lat];
  const map = new maplibregl.Map({
    container: 'map',
    style: blankStyle(BASEMAPS[themeName()]),
    center: lngLat(CONFIG.home.center),
    zoom: CONFIG.home.zoom,
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

  function addTreeLayers() {
    const before = firstLabelLayer();
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

  function envelope() {
    const b = map.getBounds();
    return {
      geometry: JSON.stringify({ xmin: b.getWest(), ymin: b.getSouth(), xmax: b.getEast(), ymax: b.getNorth(), spatialReference: { wkid: 4326 } }),
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
  $('zfit').onclick = () => map.jumpTo({ center: lngLat(CONFIG.home.center), zoom: CONFIG.home.zoom });
  new ResizeObserver(() => map.resize()).observe($('main'));

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
  let favorites = [];  // [{key, a, g:{x,y}, savedAt}], newest first
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
  let favMarkers = [];

  function treeKey(a) {
    const id = attr(a, state.f.unitId);
    return id ? `id:${id}` : `oid:${attr(a, state.oid)}`;
  }
  const isFav = (ft) => !!ft && favorites.some((f) => f.key === treeKey(ft.attributes));

  function saveFavorites() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favorites)); } catch (e) { /* storage unavailable: kept for this visit */ }
  }

  function toggleFavorite(ft) {
    const key = treeKey(ft.attributes);
    if (favorites.some((f) => f.key === key)) favorites = favorites.filter((f) => f.key !== key);
    else favorites.unshift({ key, a: ft.attributes, g: { x: ft.geometry.x, y: ft.geometry.y }, savedAt: Date.now() });
    saveFavorites();
    favoritesChanged();
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

  $('favonly').onclick = () => { state.favOnly = !state.favOnly; changed({ species: false }); };

  function openFavorite(f) {
    const ft = favFeature(f);
    map.jumpTo({ center: [f.g.x, f.g.y], zoom: Math.max(map.getZoom(), CONFIG.detailZoom) });
    select(ft);
    if (window.matchMedia('(max-width: 760px)').matches) $('main').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderFavorites() {
    // Sidebar list
    $('favn').textContent = favorites.length ? fmt.format(favorites.length) : '';
    $('favonly').hidden = !favorites.length;
    $('favonly').textContent = state.favOnly ? 'Show all trees' : 'Show only these';
    $('favonly').setAttribute('aria-pressed', String(state.favOnly));
    const list = $('favs');
    list.innerHTML = '';
    if (!favorites.length) {
      list.innerHTML = '<p>Tap ☆ Save on a tree\'s card to keep it here.</p>';
    }
    for (const f of favorites) {
      const a = f.a;
      const d = diamOf(a);
      const fam = famOfSci(attr(a, state.f.scientific));
      const row = document.createElement('div');
      row.className = 'fav';
      row.style.setProperty('--c', `var(--f-${FAMS[fam].id})`);
      const sub = [attr(a, state.f.address), d ? `${fmtIn(d)}″` : null].filter(Boolean).join(' · ');
      row.innerHTML = `<button type="button" class="fav-open"><i></i><span><b></b><small></small></span></button>
        <button type="button" class="fav-x" aria-label="Remove from favorites">×</button>`;
      row.querySelector('b').textContent = attr(a, state.f.common) || 'Unknown species';
      row.querySelector('small').textContent = sub;
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
      el.title = attr(f.a, state.f.common) || 'Favorite tree';
      el.setAttribute('aria-label', `Favorite: ${el.title}`);
      el.addEventListener('click', (e) => { e.stopPropagation(); select(favFeature(f)); });
      return new maplibregl.Marker({ element: el }).setLngLat([f.g.x, f.g.y]).addTo(map);
    });

    // Card button
    updateSaveButton();
  }

  function updateSaveButton() {
    const b = $('cfav');
    const on = isFav(state.sel);
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '★ Saved' : '☆ Save';
    b.title = on ? 'Remove from favorites' : 'Add to favorites';
  }
  $('cfav').onclick = () => { if (state.sel) toggleFavorite(state.sel); };

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
    if (state.favOnly) noun = one ? 'favorite' : 'favorites';
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
    $('clearsp').hidden = !state.sp;
  }

  $('q').oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); state.showAll = false; renderList(); };
  $('clearsp').onclick = () => { state.sp = null; changed({ species: false }); };
  $('more').onclick = () => { state.showAll = !state.showAll; renderList(); };

  function renderList() {
    let rows = speciesRows;
    if (state.q) {
      rows = rows.filter((r) => `${r.name} ${speciesInfo.get(r.name)?.sci || ''}`.toLowerCase().includes(state.q));
    }
    const max = rows.length ? Math.max(...rows.map((r) => r.count)) : 1;
    const lim = state.showAll || state.q ? rows.length : CONFIG.listTop;
    const list = $('list');
    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML = '<p>No species match. Try a different search or widen the filters.</p>';
    }
    for (const r of rows.slice(0, lim)) {
      const info = speciesInfo.get(r.name);
      const fam = info ? info.fam : OTHER;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sp' + (state.sp === r.name ? ' on' : '');
      b.setAttribute('aria-pressed', String(state.sp === r.name));
      b.style.setProperty('--c', `var(--f-${FAMS[fam].id})`);
      b.innerHTML = `<i></i><span></span><em>${fmt.format(r.count)}</em><div class="bar"><b style="width:${(r.count / max) * 100}%"></b></div>`;
      b.querySelector('span').textContent = r.name;
      b.title = r.name + (info?.sci ? ` (${info.sci})` : '');
      b.onclick = () => { state.sp = state.sp === r.name ? null : r.name; changed({ species: false }); };
      list.appendChild(b);
    }
    const more = $('more');
    more.hidden = !!state.q || rows.length <= CONFIG.listTop;
    more.textContent = state.showAll ? `Show top ${CONFIG.listTop}` : `Show all ${fmt.format(rows.length)} species`;
  }

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
      renderList();
    } catch (e) {
      if (e.name === 'AbortError') return;
      $('list').innerHTML = "<p>Couldn't load species. Try again in a moment.</p>";
    }
  }

  let refreshTimer;
  function changed({ species = true } = {}) {
    renderControls();
    renderList();
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

  // Theme switch: System (no data-theme), Light or Dark. Saved per browser.
  const themeInputs = [...document.querySelectorAll('input[name="theme"]')];
  const saved = root.dataset.theme === 'light' || root.dataset.theme === 'dark' ? root.dataset.theme : 'system';
  themeInputs.forEach((inp) => {
    inp.checked = inp.value === saved;
    inp.addEventListener('change', () => {
      if (!inp.checked) return;
      if (inp.value === 'system') delete root.dataset.theme;
      else root.dataset.theme = inp.value;
      try {
        if (inp.value === 'system') localStorage.removeItem('theme');
        else localStorage.setItem('theme', inp.value);
      } catch (e) { /* storage unavailable: the choice lasts for this visit */ }
    });
  });
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
    else famsEl.closest('section').hidden = true;
    renderControls();
    renderPill();
    renderList();
    renderFavorites();

    // Open in a useful state: the largest recorded tree, selected.
    if (largest?.geometry) {
      map.jumpTo({ center: [largest.geometry.x, largest.geometry.y], zoom: CONFIG.detailZoom });
      select(largest);
    } else {
      loadView();
    }
  }

  applyBasemap();
  init();
})();
