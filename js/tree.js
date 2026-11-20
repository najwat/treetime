// TreeTime's shared tree format and the data-quality rules every source goes through.
// Nothing here knows which source a tree came from.
//
// A tree:
//   id            stable, source-prefixed: "sdot:TRE-73801", "spr:23759"
//   source        source id ("sdot", "spr")
//   sourceId      the source's own id, as a string
//   common        common name, or null when the source has none
//   scientific    scientific name, or null
//   genus         first word of the scientific name, or null
//   family        TreeTime family group id (see FAMILIES)
//   diameterIn    trunk diameter in inches, or null when not recorded / implausible
//   heightFt      height in feet, or null
//   lat, lng      WGS84
//   planted       "YYYY-MM-DD", or null
//   plantedYearOnly  true when the source only knows the year (it stores Jan 1)
//   place         street address or park name, or null
//   placeKind     "address" | "park"
//   heritage      true for a city-designated Heritage Tree
//   alsoIn        [{id, source}] other records judged to be this same tree (set by dedupe)

// Family groups shown as chips. Real botanical groups only; any other genus is "other".
export const FAMILIES = [
  { id: 'maple',   name: 'Maples',           one: 'maple',          many: 'maples',           genera: ['Acer'] },
  { id: 'cherry',  name: 'Cherries & plums', one: 'cherry or plum', many: 'cherries & plums', genera: ['Prunus'] },
  { id: 'pear',    name: 'Pears & apples',   one: 'pear or apple',  many: 'pears & apples',   genera: ['Pyrus', 'Malus'] },
  { id: 'oak',     name: 'Oaks',             one: 'oak',            many: 'oaks',             genera: ['Quercus'] },
  { id: 'ash',     name: 'Ashes',            one: 'ash',            many: 'ashes',            genera: ['Fraxinus'] },
  { id: 'birch',   name: 'Birches',          one: 'birch',          many: 'birches',          genera: ['Betula'] },
  { id: 'conifer', name: 'Conifers',         one: 'conifer',        many: 'conifers',
    genera: ['Thuja', 'Juniperus', 'Chamaecyparis', 'Cedrus', 'Pinus', 'Picea', 'Abies', 'Tsuga', 'Sequoia', 'Sequoiadendron',
      'Metasequoia', 'Cupressus', 'Pseudotsuga', 'Calocedrus', 'Cryptomeria', 'Larix', 'Taxodium', 'Taxus'] },
  { id: 'other',   name: 'Everything else',  one: 'other tree',     many: 'other trees',      genera: [] },
];
export const OTHER_FAMILY = 'other';
export const FAMILY_IDS = FAMILIES.map((f) => f.id);
export const familyById = (id) => FAMILIES.find((f) => f.id === id) || FAMILIES[FAMILIES.length - 1];
const FAMILY_OF_GENUS = new Map(FAMILIES.flatMap((f) => f.genera.map((g) => [g.toLowerCase(), f.id])));
export const KNOWN_GENERA = FAMILIES.flatMap((f) => f.genera);

// Data-quality limits. Values outside them are treated as "not recorded", quietly.
export const MAX_DIAMETER_IN = 80;   // the data has 555″ hawthorns and 999″ placeholders
export const MAX_HEIGHT_FT = 300;    // taller than any tree in Seattle
export const MIN_PLANTED_YEAR = 1850;

export function genusOf(scientific) {
  if (!scientific) return null;
  const parts = String(scientific).trim().split(/\s+/);
  const first = (parts[0] === 'x' || parts[0] === '×') ? parts[1] : parts[0];
  if (!first || !/^[A-Za-z][A-Za-z-]+$/.test(first)) return null;
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}

export const familyOfGenus = (genus) => (genus && FAMILY_OF_GENUS.get(genus.toLowerCase())) || OTHER_FAMILY;
export const familyOf = (scientific) => familyOfGenus(genusOf(scientific));

// Names: trim, collapse spaces, and treat placeholders as missing.
const PLACEHOLDER_NAMES = new Set(['', 'unknown', 'unknown species', 'n/a', 'na', 'none', 'null', 'tbd', '?']);
export function cleanName(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return PLACEHOLDER_NAMES.has(s.toLowerCase()) ? null : s;
}

export function cleanDiameter(v) {
  const d = Number(v);
  return v !== null && v !== '' && Number.isFinite(d) && d > 0 && d <= MAX_DIAMETER_IN ? d : null;
}

export function cleanHeight(v) {
  const h = Number(v);
  return v !== null && v !== '' && Number.isFinite(h) && h > 0 && h <= MAX_HEIGHT_FT ? h : null;
}

// Planted date from epoch milliseconds (how ArcGIS returns dates, at UTC midnight).
// Future dates and dates before MIN_PLANTED_YEAR are dropped. Jan 1 means "that year".
export function cleanPlanted(ms, now = Date.now()) {
  if (ms === null || ms === undefined || ms === '') return { planted: null, plantedYearOnly: false };
  const t = Number(ms);
  if (!Number.isFinite(t)) return { planted: null, plantedYearOnly: false };
  const d = new Date(t);
  if (Number.isNaN(d.getTime()) || t > now || d.getUTCFullYear() < MIN_PLANTED_YEAR) return { planted: null, plantedYearOnly: false };
  return { planted: d.toISOString().slice(0, 10), plantedYearOnly: d.getUTCMonth() === 0 && d.getUTCDate() === 1 };
}

const validCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

// Build a tree from already-extracted source values. Returns null for records that
// can't be used at all (no id or no usable location); everything else is cleaned.
export function makeTree({ source, sourceId, common, scientific, diameter, height, plantedMs, place, placeKind = 'address', lat, lng, heritage = false, now }) {
  if (!source || sourceId === null || sourceId === undefined || String(sourceId).trim() === '') return null;
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return null;
  lat = Number(lat); lng = Number(lng);
  if (!validCoord(lat, lng)) return null;
  const sci = cleanName(scientific);
  const genus = genusOf(sci);
  return {
    id: `${source}:${String(sourceId).trim()}`,
    source,
    sourceId: String(sourceId).trim(),
    common: cleanName(common),
    scientific: sci,
    genus,
    family: familyOfGenus(genus),
    diameterIn: cleanDiameter(diameter),
    heightFt: cleanHeight(height),
    lat, lng,
    ...cleanPlanted(plantedMs, now),
    place: cleanName(place),
    placeKind,
    heritage: !!heritage,
    alsoIn: [],
  };
}

// Display helpers
export const treeName = (t) => t.common || t.scientific || 'Unknown species';
export const formatInches = (d) => (Number.isInteger(d) ? String(d) : d.toFixed(1));
export function formatPlanted(t, locale) {
  if (!t.planted) return null;
  if (t.plantedYearOnly) return t.planted.slice(0, 4);
  return new Date(`${t.planted}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}

// Filters, applied the same way to any tree (used client-side; sources translate
// the same rules into their own queries).
//   families: Set of family ids, or null for all
//   dmin, dmax: inches; dmax null = no upper bound. Any size filter excludes trees with no recorded diameter.
//   species: common name (case-insensitive), or null
export const sizeActive = (f) => (f.dmin || 0) > 0 || f.dmax != null;
export function matches(tree, f) {
  if (f.families && !f.families.has(tree.family)) return false;
  if (sizeActive(f)) {
    const d = tree.diameterIn;
    if (d == null || d < (f.dmin || 0)) return false;
    if (f.dmax != null && d >= f.dmax + 1) return false;
  }
  if (f.species && (tree.common || '').toLowerCase() !== f.species.toLowerCase()) return false;
  return true;
}
