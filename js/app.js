// TreeTime: plain ES modules, no build step.
// This file is the UI and the map. Trees arrive in TreeTime's own format (js/tree.js)
// through js/data.js; nothing here knows which service a tree came from.
import { FAMILIES, FAMILY_IDS, familyById, formatInches, formatPlanted, matches, treeName } from './tree.js';
import { SOURCES, SOURCE_IDS, sourceById } from './sources/index.js';
import { sdot } from './sources/sdot.js';
import { cachedSummary, countFiltered, fetchSummary, mergeSpecies, speciesFiltered, treesFiltered, treesInBBox } from './data.js';
import { findSaved, loadSaved, writeSaved } from './saved.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
  sliderMax: 72,        // top slider stop means "72 and larger"
  dotsMinZoom: 13.5,    // from here in, every tree in view is loaded (by tile) and filtered in the browser
  areaLimit: 3000,      // zoomed further out, dots show only when this few trees match
  detailZoom: 16,       // MapLibre zoom (512px tiles) for jumping to one tree
  boundaryUrl: 'data/seattle-boundary.geojson',
  // Bounding box of the boundary file, used for the very first frame.
  cityBox: [[-122.43578, 47.49554], [-122.23598, 47.73416]],
};

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
  families: new Set(FAMILY_IDS),
  sources: new Set(SOURCE_IDS),
  dmin: 0, dmax: CONFIG.sliderMax,
  species: null,
  savedOnly: false,     // show only saved trees
  sel: null,            // selected tree
  match: null,          // trees matching the current filters, citywide
};
let summary = null;     // per-source totals, family counts and species (js/data.js summarize)
let speciesRows = [];   // [{name, count}] for the current family/size/source filters

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const allFamilies = () => state.families.size === FAMILY_IDS.length;
const allSources = () => state.sources.size === SOURCE_IDS.length;
const sizeOn = () => state.dmin > 0 || state.dmax < CONFIG.sliderMax;
const activeSources = () => SOURCE_IDS.filter((id) => state.sources.has(id));
// The current filters in the shape tree.js matches() and every source understand.
const filters = ({ species = true } = {}) => ({
  families: allFamilies() ? null : state.families,
  dmin: state.dmin,
  dmax: state.dmax >= CONFIG.sliderMax ? null : state.dmax,
  species: species ? state.species : null,
});
const shows = (tree) => state.sources.has(tree.source) && matches(tree, filters());

const ctl = {};
function fresh(key) {
  ctl[key]?.abort();
  ctl[key] = new AbortController();
  return ctl[key].signal;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const root = document.documentElement;
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => root.dataset.theme === 'dark' || (root.dataset.theme !== 'light' && darkMq.matches);
// Colours live in style.css as tokens; the map can't read CSS, so they are read here
// (again on every theme change).
let famColors = [], ink = '', muted = '', mapColors = {};
const MAP_TOKENS = { ground: 'ground', minor: 'road-minor', major: 'road-major', casing: 'road-casing', rail: 'rail', path: 'path',
  building: 'building', park: 'park', water: 'water', boundary: 'boundary', label: 'label', halo: 'label-halo' };
function readColors() {
  const c = getComputedStyle(root);
  const token = (name) => c.getPropertyValue(name).trim();
  famColors = FAMILIES.map((f) => token('--family-' + f.id));
  ink = token('--content-primary');
  muted = token('--content-secondary');
  mapColors = Object.fromEntries(Object.entries(MAP_TOKENS).map(([k, t]) => { const v = token('--map-' + t); return [k, v === 'none' ? null : v]; }));
}
readColors();


// ---------------------------------------------------------------------------
// Basemap: OpenFreeMap vector tiles drawn by MapLibre GL. Each theme starts
// from an OpenFreeMap style and is recolored so the basemap recedes and the
// trees stand out. Colors follow DESIGN.md.
// ---------------------------------------------------------------------------
const BASEMAP_STYLES = {
  light: { style: 'https://tiles.openfreemap.org/styles/positron', roadLabelMinZoom: null },
  dark: { style: 'https://tiles.openfreemap.org/styles/dark', roadLabelMinZoom: 15 },
};
// The basemap for a theme: its style plus the --map-* colour tokens (see style.css).
const basemap = (name) => ({ ...BASEMAP_STYLES[name], ...mapColors });
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
  const p = basemap(name);
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
  style: blankStyle(basemap(themeName())),
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

const maskPaint = () => ({ 'fill-color': basemap(themeName()).ground, 'fill-opacity': isDark() ? 0.8 : 0.75, 'fill-antialias': false });
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
let shown = [];                // trees currently drawn, indexed by `i`
let treeData = { type: 'FeatureCollection', features: [] };
const canHover = window.matchMedia('(hover: hover)').matches;

// Base dot radius ~2–8px by trunk diameter; the layer scales it down when zoomed out.
const baseRadius = (d) => (d ? Math.min(8, Math.max(2, 1.2 + Math.sqrt(d) * 0.75)) : 2);
// Zoom must be the outermost expression, so any offset goes inside each stop.
const zoomRadius = (r, add = 0) => ['interpolate', ['linear'], ['zoom'],
  12, ['+', ['*', r, 0.45], add], 13, ['+', ['*', r, 0.55], add], 16, ['+', r, add]];

function treePaint() {
  const ground = basemap(themeName()).ground;
  const color = ['match', ['get', 'fam']];
  famColors.forEach((c, k) => color.push(k, c));
  color.push(famColors[famColors.length - 1]);
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

let shownById = new Map();
function drawTrees(trees) {
  shown = trees;
  shownById = new Map(trees.map((t) => [t.id, t]));
  treeData = {
    type: 'FeatureCollection',
    features: trees.map((t, i) => ({
      type: 'Feature', id: i,
      geometry: { type: 'Point', coordinates: [t.lng, t.lat] },
      properties: { i, tid: t.id, fam: FAMILY_IDS.indexOf(t.family), d: t.diameterIn || 0, r: baseRadius(t.diameterIn) },
    })),
  };
  map.getSource('trees')?.setData(treeData);
}

function selData() {
  const t = state.sel;
  if (!t) return EMPTY;
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [t.lng, t.lat] }, properties: { r: baseRadius(t.diameterIn) } }] };
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
  // Rendered dots can be one redraw behind `shown`, so look the tree up by id, not position.
  return best ? shownById.get(best.properties.tid) || null : null;
}

const sizeLabel = (t) => (t.diameterIn ? `${formatInches(t.diameterIn)}″` : null);
const tip = $('tip');
if (canHover) {
  map.on('mousemove', (e) => {
    const t = treeAt(e.point, 3);
    map.getCanvas().style.cursor = t ? 'pointer' : '';
    if (!t) { tip.hidden = true; return; }
    tip.textContent = `${treeName(t)} · ${sizeLabel(t) || 'diameter not recorded'}`;
    const q = map.project([t.lng, t.lat]);
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

// The visible area clipped to the city's bounding box as [w, s, e, n], or null if
// the view is entirely outside it (then no trees are requested).
function viewBBox() {
  const b = map.getBounds();
  const [[w, s], [e, n]] = cityBox;
  const box = [Math.max(b.getWest(), w), Math.max(b.getSouth(), s), Math.min(b.getEast(), e), Math.min(b.getNorth(), n)];
  return box[0] >= box[2] || box[1] >= box[3] ? null : box;
}

// ---------------------------------------------------------------------------
// Loading the view. Two modes:
//  - zoomed in (>= dotsMinZoom): every tree in view is loaded by map tile from each
//    source, cached, and filtered here, so filters and panning back are instant;
//  - zoomed out: the sources filter and count; dots show only when few enough match.
// ---------------------------------------------------------------------------
let ready = false;     // set once startup has the summary
let viewSeq = 0;
let viewPending = true; // a view load is queued or running (used by the tests)
let viewMode = 'none'; // 'tiles' | 'overview' | 'saved' | 'none'
let viewTrees = [];    // tiles mode: every tree loaded for this view, before filters

function redrawFromTiles() {
  const list = viewTrees.filter(shows);
  drawTrees(list);
  return list;
}

async function loadView() {
  if (!ready) return;
  const seq = ++viewSeq;
  try { await loadViewNow(seq); } finally { if (seq === viewSeq) viewPending = false; }
}
async function loadViewNow(seq) {
  const signal = fresh('view');
  const current = () => seq === viewSeq;

  if (state.savedOnly) {
    viewMode = 'saved';
    const list = savedMatches().map((r) => r.tree);
    drawTrees(list);
    setViewMsg(null);
    if (state.sel && !findSavedIn(savedMatches(), state.sel)) select(null);
    return;
  }
  const bbox = viewBBox();
  if (!bbox) { viewMode = 'none'; viewTrees = []; drawTrees([]); setViewMsg(null); return; }
  const ids = activeSources();
  const slow = setTimeout(() => { if (current()) setViewMsg('loading', 'Loading trees…'); }, 400);
  try {
    if (map.getZoom() >= CONFIG.dotsMinZoom) {
      viewMode = 'tiles';
      const res = await treesInBBox(bbox, ids, {
        isCurrent: current,
        onPartial: (trees) => { if (current()) { viewTrees = trees; redrawFromTiles(); } },
      });
      if (!current()) return;
      viewTrees = res.trees;
      const list = redrawFromTiles();
      if (res.failed && res.failed === res.total) setViewMsg('error', "Couldn't load trees for this area. Move the map to try again.");
      else if (res.failed) setViewMsg('error', "Some trees couldn't load. Move the map to try again.");
      else if (!list.length) setViewMsg('empty', filtersActive() ? 'No matching trees in this area' : 'No trees in this area');
      else setViewMsg(null);
    } else {
      viewMode = 'overview';
      const res = await treesFiltered(filters(), bbox, ids, { limit: CONFIG.areaLimit, signal });
      if (!current()) return;
      viewTrees = [];
      if (!res.trees) { drawTrees([]); setViewMsg('zoom', 'Zoom in to see individual trees'); return; }
      drawTrees(res.trees);
      if (!res.trees.length) setViewMsg('empty', filtersActive() ? 'No matching trees in this area' : 'No trees in this area');
      else setViewMsg(null);
    }
    syncSelection();
  } catch (e) {
    if (e.name === 'AbortError' || !current()) return;
    setViewMsg('error', "Couldn't load trees for this area. Move the map to try again.");
  } finally {
    clearTimeout(slow);
  }
}

// After a view loads: swap a selected snapshot for the live record of the same tree,
// and close the card if the selected tree is in view but filtered out. Saved trees
// keep their card (they may have left the city's data).
function syncSelection() {
  const sel = state.sel;
  if (!sel) return;
  const ids = new Set([sel.id, ...(sel.alsoIn || []).map((a) => a.id)]);
  const live = shown.find((t) => ids.has(t.id) || (t.alsoIn || []).some((a) => ids.has(a.id)));
  if (live) { if (live !== sel) { state.sel = live; renderCard(); } return; }
  if (findSaved(saved, sel)) return;
  const b = viewBBox();
  if (b && sel.lng >= b[0] && sel.lng <= b[2] && sel.lat >= b[1] && sel.lat <= b[3]) select(null);
}

let viewTimer;
map.on('moveend', () => { viewPending = true; clearTimeout(viewTimer); viewTimer = setTimeout(loadView, 300); });

$('zin').onclick = () => map.zoomIn();
$('zout').onclick = () => map.zoomOut();
$('zfit').onclick = () => fitCity(true);
new ResizeObserver(() => { map.resize(); applyLimits(); }).observe($('main'));

// ---------------------------------------------------------------------------
// Detail card
// ---------------------------------------------------------------------------
function select(tree) {
  state.sel = tree || null;
  if (editingName) { cancelName = true; editingName = false; nameInput.hidden = true; $('cname').hidden = false; }
  renderCard();
}

function sourceText(t) {
  const src = sourceById(t.source);
  const others = (t.alsoIn || []).map((a) => sourceById(a.source)).filter(Boolean);
  return [src ? src.cardLabel : 'Unknown source', ...others.map((o) => `also in the ${o.inventoryName}`)].join('; ');
}

function renderCard() {
  updateSelLayer();
  const card = $('card');
  const t = state.sel;
  if (!t) { card.hidden = true; return; }
  const rows = [
    ['Trunk', t.diameterIn ? `${formatInches(t.diameterIn)} in (${Math.round(t.diameterIn * 2.54)} cm)` : 'Not recorded'],
  ];
  if (t.heightFt) rows.push(['Height', `${formatInches(t.heightFt)} ft`]);
  rows.push(['Family', familyById(t.family).name]);
  if (t.place) rows.push([t.placeKind === 'park' ? 'Park' : 'Address', t.place]);
  if (t.planted) rows.push(['Planted', formatPlanted(t)]);
  if (t.heritage) rows.push(['Heritage', 'City Heritage Tree']);
  rows.push(['Source', sourceText(t)]);
  rows.push(['Location', `${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}`]);

  $('cname').textContent = treeName(t);
  $('cgen').textContent = t.scientific && t.scientific !== t.common ? t.scientific : (t.scientific ? '' : 'Scientific name not recorded');
  $('cdl').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('clink').href = `https://www.google.com/maps/search/?api=1&query=${t.lat.toFixed(5)},${t.lng.toFixed(5)}`;
  card.hidden = false;
  updateSaveButton();
}
$('cardx').onclick = () => select(null);
map.on('click', (e) => {
  if (e.originalEvent?.target?.closest?.('.fav-pin')) return; // handled by the star
  select(treeAt(e.point, 6));
});

// ---------------------------------------------------------------------------
// Saved trees: kept in this browser (js/saved.js), listed in the Saved tab and
// shown as stars on the map regardless of filters.
// ---------------------------------------------------------------------------
let saved = loadSaved(localStorage, (f) => sdot.normalize(f)).records; // newest first
let favMarkers = [];
let nameMarkers = [];
const persist = () => writeSaved(localStorage, saved);
const recordFor = (tree) => findSaved(saved, tree);
const findSavedIn = (records, tree) => findSaved(records, tree);
const nickname = (rec) => (rec && rec.name) || '';
const monthYear = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const snapshot = (tree) => ({ ...tree, alsoIn: [] }); // a saved copy keeps its own identity only

function addSaved(tree, name = '') {
  const now = Date.now();
  const rec = { id: tree.id, tree: snapshot(tree), savedAt: now, since: now, name, gone: false };
  saved.unshift(rec);
  return rec;
}
function toggleSaved(tree) {
  const rec = recordFor(tree);
  if (rec) saved = saved.filter((r) => r !== rec);
  else addSaved(tree);
  persist();
  savedChanged();
}
function savedChanged() {
  renderSaved();
  if (state.savedOnly) {
    if (!saved.length) state.savedOnly = false;
    changed({ species: false });
  }
}

// Saved trees that pass the current filters (used for "Show only these on map").
const savedMatches = () => saved.filter((r) => shows(r.tree));

$('savedonly').onchange = (e) => { state.savedOnly = e.target.checked; changed({ species: false }); };

function openSaved(rec) {
  if (isPhone()) setSheet('collapsed');
  map.flyTo({ center: [rec.tree.lng, rec.tree.lat], zoom: Math.max(map.getZoom(), CONFIG.detailZoom), duration: 900, essential: true });
  select(rec.tree);
}

function renderSaved() {
  $('savedcount').textContent = saved.length ? fmt.format(saved.length) : '';
  $('savedonlywrap').hidden = !saved.length;
  $('savedonly').checked = state.savedOnly;
  const list = $('favs');
  list.innerHTML = '';
  if (!saved.length) {
    list.innerHTML = '<div class="empty"><p><b>No saved trees yet.</b></p><p>Tap any dot on the map to open its card, then tap <b>☆ Save</b>. Saved trees show up here and as ★ on the map.</p></div>';
  }
  for (const rec of saved) {
    const t = rec.tree;
    const name = nickname(rec);
    const row = document.createElement('div');
    row.className = 'fav';
    row.style.setProperty('--c', `var(--family-${t.family})`);
    const sub = (name ? [treeName(t), sizeLabel(t), t.place] : [t.place, sizeLabel(t)]).filter(Boolean).join(' · ');
    row.classList.toggle('is-gone', !!rec.gone);
    row.innerHTML = `<button type="button" class="fav-open"><i></i><span><b></b><small></small><em class="gone-note" hidden>No longer in the city’s inventory</em></span></button>
      <button type="button" class="fav-x">×</button>`;
    row.querySelector('b').textContent = name || treeName(t);
    row.querySelector('small').textContent = sub;
    row.querySelector('.gone-note').hidden = !rec.gone;
    row.querySelector('.fav-x').setAttribute('aria-label', `Remove ${name || treeName(t)} from saved`);
    row.querySelector('.fav-open').onclick = () => openSaved(rec);
    row.querySelector('.fav-x').onclick = () => { saved = saved.filter((r) => r !== rec); persist(); savedChanged(); };
    list.appendChild(row);
  }

  // Stars on the map
  favMarkers.forEach((m) => m.remove());
  favMarkers = saved.map((rec) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'fav-pin';
    el.textContent = '★';
    el.title = nickname(rec) || treeName(rec.tree);
    el.setAttribute('aria-label', `Saved tree: ${el.title}`);
    el.addEventListener('click', (e) => { e.stopPropagation(); select(rec.tree); });
    return new maplibregl.Marker({ element: el }).setLngLat([rec.tree.lng, rec.tree.lat]).addTo(map);
  });

  // Nickname labels under the dot (shown from zoom 17 via CSS on the map container)
  nameMarkers.forEach((m) => m.remove());
  nameMarkers = saved.filter((rec) => nickname(rec)).map((rec) => {
    const el = document.createElement('div');
    el.className = 'tree-label';
    el.textContent = rec.name;
    return new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, 9] }).setLngLat([rec.tree.lng, rec.tree.lat]).addTo(map);
  });
  updateLabelZoom();
  updateSaveButton();
}

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
  const t = state.sel;
  const name = nickname(rec);
  if (!editingName) $('cname').textContent = name || treeName(t);
  $('cspecies').textContent = [treeName(t), sizeLabel(t)].filter(Boolean).join(' · ');
  $('cspecies').hidden = !name;
  $('csince').textContent = on ? `Saved since ${monthYear(rec.since)}` : '';
  $('csince').hidden = !on;
  $('cgone').hidden = !rec?.gone;
  const pen = $('cnamebtn');
  pen.title = name ? 'Rename this tree' : 'Name this tree';
  pen.setAttribute('aria-label', pen.title);
}
$('cfav').onclick = () => { if (state.sel) toggleSaved(state.sel); };

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
      if (!rec) rec = addSaved(state.sel);
      rec.name = v;
      persist();
      savedChanged();
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

// On load, check saved trees against each source's active inventory. Trees still
// there get their snapshot refreshed; trees that are gone keep their last known
// details and are marked. Records under a legacy id can't be checked and are left alone.
async function checkInventory() {
  const bySource = new Map();
  for (const rec of saved) {
    if (rec.tree.sourceId.startsWith('legacy-') || !sourceById(rec.tree.source)) continue;
    if (!bySource.has(rec.tree.source)) bySource.set(rec.tree.source, []);
    bySource.get(rec.tree.source).push(rec);
  }
  let dirty = false;
  await Promise.all([...bySource].map(async ([sourceId, recs]) => {
    let found;
    try { found = await sourceById(sourceId).byIds(recs.map((r) => r.tree.sourceId)); } catch (e) { return; } // can't tell right now
    const live = new Map(found.map((t) => [t.id, t]));
    for (const rec of recs) {
      const t = live.get(rec.id);
      if (!!rec.gone !== !t) { rec.gone = !t; dirty = true; }
      if (t && JSON.stringify(snapshot(t)) !== JSON.stringify(rec.tree)) { rec.tree = snapshot(t); dirty = true; }
    }
  }));
  if (dirty) { persist(); renderSaved(); if (state.sel && recordFor(state.sel)) updateSaveButton(); }
}

// ---------------------------------------------------------------------------
// Result pill: a plain-words summary of the active filters, or the view message
// ---------------------------------------------------------------------------
const filtersActive = () => !allFamilies() || !allSources() || sizeOn() || !!state.species || state.savedOnly;

function sizeText() {
  if (!sizeOn()) return null;
  const { dmin, dmax } = state;
  if (dmax >= CONFIG.sliderMax) return `${dmin}″+`;
  if (dmin === 0) return `under ${dmax + 1}″`;
  return `${dmin}–${dmax}″`;
}

// Family names as separate pieces so a line can wrap between them.
function familyPieces() {
  if (allFamilies()) return null;
  const ids = FAMILY_IDS.filter((id) => state.families.has(id));
  if (ids.length <= 2) return ids.map((id) => familyById(id).name);
  return [`${ids.length} families`];
}

// Plain-words summary as parts, e.g. [["1,204 maples"], ["18–35″"]]; each part is a
// list of pieces that must not break internally.
function describeFilters() {
  const n = state.savedOnly ? savedMatches().length : state.match;
  const one = n === 1;
  let noun = one ? 'tree' : 'trees';
  let famShown = false;
  const onlySource = !allSources() && state.sources.size === 1 ? sourceById([...state.sources][0]) : null;
  if (state.savedOnly) noun = one ? 'saved tree' : 'saved trees';
  else if (!state.species && state.families.size === 1) { const f = familyById([...state.families][0]); noun = one ? f.one : f.many; famShown = true; }
  else if (!state.species && onlySource) noun = one ? onlySource.noun.toLowerCase() : `${onlySource.noun.toLowerCase()}s`;
  const parts = [[`${n == null ? '…' : fmt.format(n)} ${noun}`]];
  if (state.species) parts.push([state.species]);
  else if (!famShown && familyPieces()) parts.push(familyPieces());
  if (sizeText()) parts.push([sizeText()]);
  if (onlySource && !noun.startsWith(onlySource.noun.toLowerCase())) parts.push([`${onlySource.label.toLowerCase()} only`]);
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
  $('pillclear').textContent = state.savedOnly && allFamilies() && allSources() && !sizeOn() && !state.species ? 'Clear' : 'Clear filters';
}

function clearFilters() {
  state.families = new Set(FAMILY_IDS);
  state.sources = new Set(SOURCE_IDS);
  state.dmin = 0;
  state.dmax = CONFIG.sliderMax;
  $('dmin').value = state.dmin;
  $('dmax').value = state.dmax;
  state.species = null;
  state.savedOnly = false;
  customOpen = false;
  changed();
}
$('pillclear').onclick = clearFilters;

// ---------------------------------------------------------------------------
// Explore tab: source toggles, family chips, size presets, custom range
// ---------------------------------------------------------------------------
const sumOver = (pick) => activeSources().reduce((n, id) => n + (pick(summary?.sources?.[id]) || 0), 0);
const totalTrees = () => sumOver((s) => s?.total);

const srcEl = $('sources');
function buildSourceChips() {
  srcEl.innerHTML = '';
  for (const s of SOURCES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip src';
    b.dataset.source = s.id;
    b.innerHTML = `<i></i>${esc(s.label)} <small></small>`;
    b.onclick = () => {
      if (state.sources.has(s.id) && state.sources.size > 1) state.sources.delete(s.id);
      else if (!state.sources.has(s.id)) state.sources.add(s.id);
      else state.sources = new Set(SOURCE_IDS.filter((id) => id !== s.id)); // the last one on: switch to the others
      changed();
    };
    srcEl.appendChild(b);
  }
}

const famsEl = $('fams');
function buildFamilyChips() {
  famsEl.innerHTML = '';
  for (const f of FAMILIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.family = f.id;
    b.style.setProperty('--c', `var(--family-${f.id})`);
    b.innerHTML = `<i></i>${esc(f.name)} <small></small>`;
    b.onclick = () => {
      if (allFamilies()) state.families = new Set([f.id]);
      else if (state.families.has(f.id)) {
        state.families.delete(f.id);
        if (!state.families.size) state.families = new Set(FAMILY_IDS);
      } else state.families.add(f.id);
      state.species = null;
      changed();
    };
    famsEl.appendChild(b);
  }
}
$('allfam').hidden = false;
$('allfam').onclick = () => { state.families = new Set(FAMILY_IDS); state.species = null; changed(); };

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

const isPreset = () => SIZES.some((sz) => state.dmin === sz.r[0] && state.dmax === sz.r[1]);
let customOpen = false;
function renderControls() {
  for (const b of srcEl.children) {
    const id = b.dataset.source;
    b.setAttribute('aria-pressed', String(state.sources.has(id)));
    b.querySelector('small').textContent = summary ? fmt.format(summary.sources[id]?.total || 0) : '';
  }
  for (const b of famsEl.children) {
    const id = b.dataset.family;
    b.setAttribute('aria-pressed', String(state.families.has(id)));
    b.querySelector('small').textContent = summary ? fmt.format(sumOver((s) => s?.families?.[id])) : '';
  }
  SIZES.forEach((s) => {
    const on = state.dmin === s.r[0] && state.dmax === s.r[1];
    s.el.classList.toggle('on', on);
    s.el.setAttribute('aria-pressed', String(on));
  });
  const max = CONFIG.sliderMax;
  $('rangeout').textContent = sizeOn() ? `${state.dmin}–${state.dmax >= max ? `${max}+` : state.dmax} in` : 'Any size';
  $('fill').style.left = `${(state.dmin / max) * 100}%`;
  $('fill').style.width = `${((state.dmax - state.dmin) / max) * 100}%`;
  // The slider stays open while a custom (non-preset) range is set.
  const open = customOpen || (sizeOn() && !isPreset());
  $('custom').hidden = !open;
  $('customtoggle').setAttribute('aria-expanded', String(open));
  $('customtoggle').classList.toggle('on', open);
  syncSearch();
}
$('customtoggle').onclick = () => {
  if (sizeOn() && !isPreset() && !customOpen) return; // can't hide the slider while it holds the only record of the range
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

const speciesMeta = (name) => summary?.speciesFamily?.[String(name).toLowerCase()];
const speciesColor = (name) => `var(--family-${speciesMeta(name)?.family || 'other'})`;

function syncSearch() {
  if (document.activeElement !== qEl) qEl.value = state.species || '';
  $('qclear').hidden = !qEl.value && !state.species;
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
  const bbox = viewBBox();
  if (!bbox) { sugItems = []; renderSuggest(); return; }
  const f = filters({ species: false });
  // Zoomed in, the trees are already here: count them directly.
  if (viewMode === 'tiles') {
    const inView = viewTrees.filter((t) => state.sources.has(t.source) && matches(t, f) && t.lng >= bbox[0] && t.lng <= bbox[2] && t.lat >= bbox[1] && t.lat <= bbox[3]);
    sugItems = mergeSpecies(inView.map((t) => ({ common: t.common, count: 1 }))).slice(0, 5);
    sugActive = -1; renderSuggest(); return;
  }
  const key = JSON.stringify([bbox, activeSources(), [...(f.families || [])], f.dmin, f.dmax]);
  if (viewTop.key === key && viewTop.rows) { sugItems = viewTop.rows; sugActive = -1; renderSuggest(); return; }
  sugItems = null; renderSuggest();
  const signal = fresh('viewtop');
  try {
    const rows = await speciesFiltered(f, activeSources(), { bbox, limit: 5, signal });
    viewTop = { key, rows };
    if (sugMode === 'view') { sugItems = rows; sugActive = -1; renderSuggest(); }
  } catch (e) {
    if (e.name !== 'AbortError' && sugMode === 'view') { sugItems = []; renderSuggest(); }
  }
}

function updateSuggest() {
  const t = qEl.value.trim().toLowerCase();
  if (!t || qEl.value === state.species) {
    sugMode = 'view';
    loadViewTop();
  } else {
    sugMode = 'match';
    sugItems = speciesRows
      .filter((r) => `${r.name} ${speciesMeta(r.name)?.scientific || ''}`.toLowerCase().includes(t))
      .slice(0, 8);
    sugActive = sugItems.length ? 0 : -1;
    renderSuggest();
  }
  openSuggest();
}

function pickSpecies(name) {
  state.species = name;
  closeSuggest();
  qEl.value = name;
  qEl.blur();
  changed({ species: false });
}

qEl.addEventListener('focus', () => {
  if (isPhone()) setSheet('expanded');
  if (qEl.value === state.species) qEl.select();
  updateSuggest();
});
qEl.addEventListener('input', () => {
  $('qclear').hidden = !qEl.value && !state.species;
  if (!qEl.value && state.species) { state.species = null; changed({ species: false }); }
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
  } else if (e.key === 'Escape') { closeSuggest(); qEl.value = state.species || ''; qEl.blur(); }
});
qEl.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement === qEl) return;
    closeSuggest();
    qEl.value = state.species || '';
    $('qclear').hidden = !state.species;
  }, 0);
});
sugEl.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus so the click lands
sugEl.addEventListener('click', (e) => {
  const opt = e.target.closest('.opt');
  if (opt) pickSpecies(sugItems[+opt.dataset.k].name);
});
$('qclear').onclick = () => {
  const had = !!state.species;
  state.species = null;
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
  if (state.savedOnly) return; // the pill counts saved trees locally
  try {
    const plain = allFamilies() && !sizeOn() && !state.species;
    state.match = plain && summary ? totalTrees() : await countFiltered(filters(), activeSources(), { signal });
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  renderPill();
}

// The species the search suggests from: all species for the current family, size
// and source filters. With no family or size filter this comes from the summary.
async function loadSpecies() {
  const signal = fresh('species');
  try {
    if (allFamilies() && !sizeOn() && summary) {
      speciesRows = mergeSpecies(activeSources().flatMap((id) => (summary.sources[id]?.species || []).map((s) => ({ common: s.name, count: s.count }))));
    } else {
      speciesRows = await speciesFiltered(filters({ species: false }), activeSources(), { signal });
    }
    if (!sugEl.hidden && sugMode === 'match') updateSuggest();
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
}

let refreshTimer;
let lastSourcesKey = SOURCE_IDS.join();
function changed({ species = true } = {}) {
  renderControls();
  renderSaved();
  renderPill();
  // Zoomed in with the same sources, the trees are already loaded: filter now.
  const sourcesKey = activeSources().join();
  const local = viewMode === 'tiles' && !state.savedOnly && sourcesKey === lastSourcesKey && map.getZoom() >= CONFIG.dotsMinZoom;
  lastSourcesKey = sourcesKey;
  if (local) {
    const list = redrawFromTiles();
    if (!list.length) setViewMsg('empty', filtersActive() ? 'No matching trees in this area' : 'No trees in this area');
    else if (viewMsg?.kind === 'empty') setViewMsg(null);
    syncSelection();
  }
  if (!local) viewPending = true;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadCount();
    if (species) loadSpecies();
    if (!local) loadView();
  }, local ? 0 : 250);
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

// Drag from the grab handle, header or tab bar; tap the handle (or press Enter on it) to toggle.
const toggleSheet = () => setSheet(sheetState === 'expanded' ? 'collapsed' : 'expanded');
let lastTap = 0;
$('grab').addEventListener('click', () => { if (performance.now() - lastTap > 500) toggleSheet(); }); // keyboard and assistive tech
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
  if (!d.moved) { if (e.target.closest('.grab')) { toggleSheet(); d.tapped = performance.now(); lastTap = d.tapped; } return; }
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


// "About the data": one entry per source, built from the sources themselves.
function renderAbout() {
  $('about-sources').innerHTML = SOURCES.map((s) => `<li><b>${esc(s.label)}</b>: ${esc(s.covers)}
    <span class="fine">${summary ? `${fmt.format(summary.sources[s.id]?.total || 0)} trees. ` : ''}${esc(s.refresh)}. Credit: ${esc(s.credit)}.
    <a href="${esc(s.infoUrl)}" target="_blank" rel="noopener">Dataset page</a></span></li>`).join('');
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
function applySummary(s) {
  summary = s;
  renderControls();
  renderAbout();
  loadSpecies();
  loadCount();
}

async function init() {
  buildSourceChips();
  buildFamilyChips();
  renderControls();
  renderSaved();
  renderAbout();

  // Show stored counts at once on a repeat visit, then refresh them if they're old.
  const stored = await cachedSummary();
  if (stored) applySummary(stored.summary);
  ready = true;
  loadView();
  checkInventory();

  if (!stored || !stored.fresh) {
    try { applySummary(await fetchSummary()); }
    catch (e) { if (!stored) setViewMsg('error', "Couldn't reach the city's tree data. Try reloading."); }
  }

  // Open on the whole city. On wider screens, also open the largest recorded
  // tree's card; on phones it would cover half the city, so it stays closed.
  if (!isPhone() && !state.sel && !userMoved) {
    try {
      const candidates = (await Promise.all(SOURCES.map((s) => s.largest().catch(() => null)))).filter(Boolean);
      const largest = candidates.sort((a, b) => b.diameterIn - a.diameterIn)[0];
      if (largest && !state.sel && !userMoved) select(largest);
    } catch (e) { /* optional */ }
  }
}

let initialTab = 'explore';
try { if (TABS.includes(localStorage.getItem('tab'))) initialTab = localStorage.getItem('tab'); } catch (e) { /* ignore */ }
setTab(initialTab);
setSheet('collapsed', false);
applyBasemap();
init();

// A handle for tests and debugging in the console. Not an API.
window.__treetime = { map, state, get shown() { return shown; }, get saved() { return saved; }, get viewMode() { return viewMode; }, get settled() { return ready && !viewPending; } };
