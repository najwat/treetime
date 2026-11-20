// Saved trees: stored in this browser only (localStorage), in TreeTime's own format
// so they don't depend on any source's field names.
//
// A record: { id, tree, savedAt, since, name, gone }
//   id       the tree's stable TreeTime id ("sdot:TRE-73801"); never changes once saved
//   tree     a snapshot of the tree as last seen, so the list works offline and
//            for trees that have left the city's data
//   savedAt  when it was (last) saved, ms
//   since    when it was first saved, ms
//   name     private nickname, '' if none
//   gone     true when the tree is no longer in its source's active inventory
//
// Earlier versions stored raw SDOT attributes under "favoriteTrees" (and, briefly,
// "treetimeCrushes"). Those are migrated on first load and left in place, untouched,
// so rolling the site back still finds them.
export const SAVED_KEY = 'treetime.saved.v2';
export const LEGACY_FAVORITES_KEY = 'favoriteTrees';
export const LEGACY_CRUSHES_KEY = 'treetimeCrushes';

const parse = (raw) => { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

// One legacy record -> v2 record, or null if it can't be used at all.
// `normalizeSdot` is the SDOT source's normalize(feature): old saves were all SDOT.
function migrateOne(old, normalizeSdot, now) {
  if (!old || typeof old !== 'object' || !old.a || !old.g) return null;
  const a = { ...old.a };
  // Very old records could lack UNITID; fall back to a legacy id that can never
  // collide with a real one and keep the snapshot.
  const hasUnit = Object.keys(a).some((k) => k.toUpperCase() === 'UNITID' && a[k]);
  if (!hasUnit) {
    const oid = a.OBJECTID ?? String(old.key || '').replace(/^oid:/, '');
    a.UNITID = `legacy-${oid || Math.abs(Math.round(old.g.x * 1e6))}-${Math.abs(Math.round(old.g.y * 1e6))}`;
  }
  const tree = normalizeSdot({ attributes: a, geometry: { x: Number(old.g.x), y: Number(old.g.y) } });
  if (!tree) return null;
  const savedAt = num(old.savedAt, num(old.addedAt, num(old.since, now)));
  return {
    id: tree.id,
    tree,
    savedAt,
    since: Math.min(num(old.since, savedAt), savedAt),
    name: typeof old.name === 'string' ? Array.from(old.name.trim()).slice(0, 30).join('') : '',
    gone: !!old.gone,
  };
}

// Legacy stores -> v2 records (deduplicated by id; earliest `since` and any name win).
export function migrateLegacy({ favorites = [], crushes = [] }, normalizeSdot, now = Date.now()) {
  const byId = new Map();
  const add = (old) => {
    const rec = migrateOne(old, normalizeSdot, now);
    if (!rec) return;
    const prev = byId.get(rec.id);
    if (!prev) byId.set(rec.id, rec);
    else byId.set(rec.id, { ...prev, since: Math.min(prev.since, rec.since), savedAt: Math.max(prev.savedAt, rec.savedAt), name: prev.name || rec.name, gone: prev.gone && rec.gone });
  };
  favorites.forEach(add);
  crushes.filter((c) => c && c.on !== false).forEach(add);
  return [...byId.values()].sort((x, y) => y.savedAt - x.savedAt);
}

const validRecord = (r) => r && typeof r.id === 'string' && r.tree && Number.isFinite(r.tree.lat) && Number.isFinite(r.tree.lng);

// Read saved trees, migrating older data the first time. Never throws.
export function loadSaved(storage, normalizeSdot, now = Date.now()) {
  let raw = null;
  try { raw = storage.getItem(SAVED_KEY); } catch (e) { return { records: [], migrated: false }; }
  if (raw !== null) {
    return { records: parse(raw).filter(validRecord).map((r) => ({ name: '', gone: false, ...r, since: num(r.since, num(r.savedAt, now)), savedAt: num(r.savedAt, now) })), migrated: false };
  }
  let favorites = [], crushes = [];
  try { favorites = parse(storage.getItem(LEGACY_FAVORITES_KEY)); crushes = parse(storage.getItem(LEGACY_CRUSHES_KEY)); } catch (e) { /* ignore */ }
  const records = migrateLegacy({ favorites, crushes }, normalizeSdot, now);
  if (favorites.length || crushes.length) writeSaved(storage, records);
  return { records, migrated: records.length > 0 };
}

export function writeSaved(storage, records) {
  try { storage.setItem(SAVED_KEY, JSON.stringify(records)); return true; } catch (e) { return false; } // storage full/unavailable: kept for this visit
}

// A tree counts as saved if its id, or the id of a record judged to be the same
// tree (alsoIn), is saved. The saved id itself never changes.
export function findSaved(records, tree) {
  if (!tree) return null;
  const ids = new Set([tree.id, ...(tree.alsoIn || []).map((a) => a.id)]);
  return records.find((r) => ids.has(r.id)) || null;
}
