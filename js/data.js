// Loading and caching across sources. The app asks for trees in TreeTime terms and
// never sees which service they came from.
import { SOURCES, sourceById } from './sources/index.js';
import { tilesForBBox } from './sources/arcgis.js';
import { cacheGet, cacheSet } from './cache.js';
import { dedupe } from './dedupe.js';
import { familyOf, cleanName, FAMILY_IDS } from './tree.js';

export const TILE_ZOOM = 14;                    // data tiles; one request per source per tile
export const TILE_FRESH_MS = 6 * 60 * 60 * 1000;   // reuse a stored tile for 6 hours
export const SUMMARY_FRESH_MS = 6 * 60 * 60 * 1000;
const MEMORY_TILES = 64;

const memory = new Map();   // key -> trees (insertion order = LRU)
const inflight = new Map(); // key -> promise
const remember = (key, trees) => {
  memory.delete(key); memory.set(key, trees);
  while (memory.size > MEMORY_TILES) memory.delete(memory.keys().next().value);
};
const tileKey = (sourceId, z, x, y) => `tile:${sourceId}:${z}/${x}/${y}`;

// One source's trees for one tile: memory, then the stored copy if fresh, then the
// network. If the network fails, a stale stored copy is better than nothing.
export function loadTile(sourceId, z, x, y) {
  const key = tileKey(sourceId, z, x, y);
  if (memory.has(key)) { const t = memory.get(key); remember(key, t); return Promise.resolve(t); }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const stored = await cacheGet(key);
    if (stored && Date.now() - stored.at < TILE_FRESH_MS) { remember(key, stored.value); return stored.value; }
    try {
      const trees = await sourceById(sourceId).tile(z, x, y);
      remember(key, trees);
      cacheSet(key, trees);
      return trees;
    } catch (e) {
      if (stored) { remember(key, stored.value); return stored.value; }
      throw e;
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Every tree in the given bounds from the given sources, each real tree once.
// `onPartial` is called as tiles arrive so the map can fill in progressively.
export async function treesInBBox(bbox, sourceIds, { onPartial, isCurrent = () => true } = {}) {
  const jobs = [];
  for (const [z, x, y] of tilesForBBox(bbox, TILE_ZOOM)) for (const id of sourceIds) jobs.push([id, z, x, y]);
  const loaded = [];
  let failed = 0;
  await Promise.all(jobs.map(async ([id, z, x, y]) => {
    try {
      loaded.push(await loadTile(id, z, x, y));
      if (onPartial && isCurrent() && loaded.length < jobs.length) onPartial(merge(loaded));
    } catch (e) { failed += 1; }
  }));
  return { trees: merge(loaded), failed, total: jobs.length };
}
const merge = (lists) => dedupe(lists.flat(), { order: SOURCES.map((s) => s.id) }).trees;

// Matching trees for a zoomed-out view, filtered by the sources themselves.
// Returns { count } alone when there are more than `limit`.
export async function treesFiltered(filters, bbox, sourceIds, { limit, signal } = {}) {
  const counts = await Promise.all(sourceIds.map((id) => sourceById(id).count(filters, { bbox, signal })));
  const count = counts.reduce((a, b) => a + b, 0);
  if (count > limit) return { count, trees: null };
  const lists = await Promise.all(sourceIds.map((id, i) => (counts[i] ? sourceById(id).trees(filters, { bbox, limit, signal }) : [])));
  return { count, trees: merge(lists) };
}

export async function countFiltered(filters, sourceIds, { signal } = {}) {
  const counts = await Promise.all(sourceIds.map((id) => sourceById(id).count(filters, { signal })));
  return counts.reduce((a, b) => a + b, 0);
}

// Species for the current filters, merged across sources by common name.
export async function speciesFiltered(filters, sourceIds, { bbox, limit, signal } = {}) {
  const lists = await Promise.all(sourceIds.map((id) => sourceById(id).species(filters, { bbox, limit, signal })));
  return mergeSpecies(lists.flat()).slice(0, limit || Infinity);
}
export function mergeSpecies(rows) {
  const by = new Map();
  for (const r of rows) {
    const name = cleanName(r.common);
    if (!name) continue;
    const k = name.toLowerCase();
    const cur = by.get(k);
    if (cur) cur.count += r.count; else by.set(k, { name, count: r.count });
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Per-source totals, family counts and the species list, from one grouped query per
// source. Stored for a few hours: shown immediately on a repeat visit, then refreshed.
export function summarize(rowsBySource) {
  const sources = {};
  const speciesFamily = {};
  for (const [id, rows] of Object.entries(rowsBySource)) {
    const families = Object.fromEntries(FAMILY_IDS.map((f) => [f, 0]));
    const species = new Map();
    let total = 0;
    for (const r of rows) {
      total += r.count;
      const fam = familyOf(cleanName(r.scientific));
      families[fam] += r.count;
      const name = cleanName(r.common);
      if (!name) continue;
      const k = name.toLowerCase();
      const cur = species.get(k) || { name, count: 0, best: 0, scientific: null };
      cur.count += r.count;
      if (r.count > cur.best) { cur.best = r.count; cur.scientific = cleanName(r.scientific); }
      species.set(k, cur);
    }
    for (const s of species.values()) {
      const k = s.name.toLowerCase();
      if (!speciesFamily[k] || s.count > speciesFamily[k].count) speciesFamily[k] = { family: familyOf(s.scientific), scientific: s.scientific, count: s.count };
    }
    sources[id] = { total, families, species: [...species.values()].map(({ name, count }) => ({ name, count })) };
  }
  return { sources, speciesFamily, at: Date.now() };
}

const SUMMARY_KEY = 'summary:v1';
export async function cachedSummary() {
  const c = await cacheGet(SUMMARY_KEY);
  return c ? { summary: c.value, fresh: Date.now() - c.at < SUMMARY_FRESH_MS } : null;
}
export async function fetchSummary() {
  const entries = await Promise.all(SOURCES.map(async (s) => [s.id, await s.species({}, { withScientific: true })]));
  const summary = summarize(Object.fromEntries(entries));
  cacheSet(SUMMARY_KEY, summary);
  return summary;
}
