// Likely duplicates across sources: the same tree recorded by two owners (a street
// tree on a park boulevard, for example). Two records from different sources are
// treated as one tree when they are within MAX_METERS and share a genus, or within
// CLOSE_METERS when either has no genus. The more detailed record is shown and
// remembers the other in `alsoIn`. Ids never change, so a saved tree stays valid.
export const MAX_METERS = 3;
export const CLOSE_METERS = 1;
const M_PER_DEG_LAT = 111320;

const detail = (t) => (t.diameterIn != null) + (t.planted != null) + (t.heightFt != null) + (t.place != null) + (t.common != null) + (t.scientific != null);

// Stable preference: more detail wins; ties go to the source listed first in `order`.
function better(a, b, order) {
  const da = detail(a), db = detail(b);
  if (da !== db) return da > db ? a : b;
  const ia = order.indexOf(a.source), ib = order.indexOf(b.source);
  if (ia !== ib) return (ia === -1 ? 99 : ia) < (ib === -1 ? 99 : ib) ? a : b;
  return a.id < b.id ? a : b;
}

export function metersBetween(a, b) {
  const kx = M_PER_DEG_LAT * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * M_PER_DEG_LAT);
}

// Returns { trees, replaced } where `trees` has each real tree once (winners carry
// alsoIn) and `replaced` maps a hidden record's id to the id shown instead.
// Pairing is one-to-one and deterministic (nearest match, ids in sorted order).
export function dedupe(trees, { order = [] } = {}) {
  const replaced = new Map();
  const reset = (t) => (t.alsoIn && t.alsoIn.length ? { ...t, alsoIn: [] } : t);
  if (new Set(trees.map((t) => t.source)).size < 2) return { trees: trees.map(reset), replaced };

  const cell = 0.00005; // ~5.5 m of latitude; the 3×3 neighbourhood covers the 3 m radius
  const grid = new Map();
  for (const t of trees) {
    const k = `${Math.floor(t.lng / cell)}:${Math.floor(t.lat / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(t);
  }
  const matched = new Set();
  const also = new Map(); // winner id -> [{id, source}]
  for (const t of trees.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (matched.has(t.id)) continue;
    const cx = Math.floor(t.lng / cell), cy = Math.floor(t.lat / cell);
    let best = null, bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const o of grid.get(`${cx + dx}:${cy + dy}`) || []) {
        if (o.source === t.source || matched.has(o.id)) continue;
        const limit = t.genus && o.genus ? (t.genus === o.genus ? MAX_METERS : 0) : CLOSE_METERS;
        const d = metersBetween(t, o);
        if (d <= limit && d < bestD) { best = o; bestD = d; }
      }
    }
    if (!best) continue;
    matched.add(t.id); matched.add(best.id);
    const win = better(t, best, order), lose = win === t ? best : t;
    replaced.set(lose.id, win.id);
    also.set(win.id, [{ id: lose.id, source: lose.source }]);
  }
  const out = [];
  for (const t of trees) {
    if (replaced.has(t.id)) continue;
    out.push(also.has(t.id) ? { ...t, alsoIn: also.get(t.id) } : reset(t));
  }
  return { trees: out, replaced };
}
