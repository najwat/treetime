// A stand-in for the network: the two ArcGIS tree layers (backed by fixtures of real
// records in SQLite, so the app's actual WHERE clauses run), MapLibre from
// node_modules, a blank basemap style, and no web fonts.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(here(`../fixtures/${name}`)));

// Records added on top of the real fixtures to exercise the data-quality rules.
export const BAD_SDOT = [
  { attributes: { OBJECTID: 900001, UNITID: 'TRE-BAD-1', COMMON_NAME: 'English Midland Hawthorn', SCIENTIFIC_NAME: 'Crataegus laevigata', DIAM: 555, UNITDESC: '1 TEST ST', PLANTED_DATE: 1820707200000, TREEHEIGHT: 0, HERITAGE: 'N', CURRENT_STATUS: 'INSVC', OWNERSHIP: 'SDOT' }, geometry: { x: -122.35250, y: 47.63900 } },
  { attributes: { OBJECTID: 900002, UNITID: 'TRE-BAD-2', COMMON_NAME: 'Unknown', SCIENTIFIC_NAME: null, DIAM: 0, UNITDESC: null, PLANTED_DATE: null, TREEHEIGHT: null, HERITAGE: 'Y', CURRENT_STATUS: 'INSVC', OWNERSHIP: 'PRIV' }, geometry: { x: -122.35240, y: 47.63905 } },
];

export function loadFixtures() {
  const sdot = [...fixture('sdot-queen-anne.json').features, ...BAD_SDOT];
  const spr = fixture('spr-queen-anne.json').features;
  return { sdot, spr };
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  const { sdot, spr } = loadFixtures();
  const load = (table, feats) => {
    const cols = [...new Set(feats.flatMap((f) => Object.keys(f.attributes)))];
    db.exec(`CREATE TABLE ${table} (${cols.map((c) => `"${c}"`).join(',')}, x REAL, y REAL)`);
    const ins = db.prepare(`INSERT INTO ${table} VALUES (${cols.map(() => '?').join(',')}, ?, ?)`);
    for (const f of feats) ins.run(...cols.map((c) => f.attributes[c] ?? null), f.geometry.x, f.geometry.y);
    return cols;
  };
  return { db, cols: { SDOT_Trees_CDL: load('SDOT_Trees_CDL', sdot), SPR_Tree_View: load('SPR_Tree_View', spr) } };
}

function answer({ db, cols }, layer, q, pageSize) {
  let where = q.where || '1=1';
  if (q.geometry) { const [w, s, e, n] = q.geometry.split(',').map(Number); where = `(${where}) AND x >= ${w} AND x <= ${e} AND y >= ${s} AND y <= ${n}`; }
  if (q.returnCountOnly === 'true') return { count: db.prepare(`SELECT COUNT(*) n FROM ${layer} WHERE ${where}`).get().n };
  const limit = Math.min(Number(q.resultRecordCount) || pageSize, pageSize), offset = Number(q.resultOffset) || 0;
  if (q.groupByFieldsForStatistics) {
    const by = q.groupByFieldsForStatistics;
    const rows = db.prepare(`SELECT ${by}, COUNT(*) n FROM ${layer} WHERE ${where} GROUP BY ${by} ORDER BY ${q.orderByFields || 'n DESC'} LIMIT ${limit + 1} OFFSET ${offset}`).all();
    return { features: rows.slice(0, limit).map((a) => ({ attributes: { ...a } })), ...(rows.length > limit ? { exceededTransferLimit: true } : {}) };
  }
  const fields = q.outFields && q.outFields !== '*' ? q.outFields.split(',') : cols[layer];
  const rows = db.prepare(`SELECT ${fields.map((f) => `"${f}"`).join(',')}, x, y FROM ${layer} WHERE ${where} ORDER BY ${q.orderByFields || 'OBJECTID'} LIMIT ${limit + 1} OFFSET ${offset}`).all();
  return {
    features: rows.slice(0, limit).map(({ x, y, ...a }) => ({ attributes: a, ...(q.returnGeometry === 'false' ? {} : { geometry: { x, y } }) })),
    ...(rows.length > limit ? { exceededTransferLimit: true } : {}),
  };
}

const BLANK_STYLE = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f4f6f1' } }] };

// Install the mock on a page. Returns a log of tree-service requests and switches
// to simulate failures. `pageSize` is small by default so pagination is exercised.
export async function mockNetwork(page, { pageSize = 100 } = {}) {
  const ctx = makeDb();
  const state = { requests: [], fail: false, delayMs: 0 };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    if (url.hostname === 'unpkg.com' && url.pathname.includes('/maplibre-gl@')) {
      return route.fulfill({ path: here(`../../node_modules/maplibre-gl/dist/${url.pathname.split('/').pop()}`) });
    }
    if (url.hostname === 'tiles.openfreemap.org') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BLANK_STYLE) });
    if (url.hostname.startsWith('fonts.')) return route.fulfill({ contentType: 'text/css', body: '' });
    const m = url.hostname === 'services.arcgis.com' && url.pathname.match(/\/services\/([^/]+)\/FeatureServer\/0\/query$/);
    if (m) {
      const q = Object.fromEntries(new URLSearchParams(req.method() === 'POST' ? req.postData() : url.search.slice(1)));
      const kind = q.returnCountOnly ? 'count' : q.groupByFieldsForStatistics ? 'species' : q.resultType === 'tile' ? 'tile' : 'features';
      state.requests.push({ layer: m[1], kind, where: q.where, bbox: q.geometry || null, offset: q.resultOffset || null });
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.fail) return route.abort('failed');
      try { return route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer(ctx, m[1], q, pageSize)) }); }
      catch (e) { return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: { message: `mock: ${e.message}` } }) }); }
    }
    return route.abort('blockedbyclient');
  });
  return state;
}

// Where the fixture trees are (Queen Anne Boulevard), and helpers to drive the map.
export const FIXTURE_CENTER = [-122.350944, 47.640095];
export const tt = (page, fn, arg) => page.evaluate(fn, arg);
export async function ready(page) {
  await page.goto('./');
  await page.waitForFunction(() => window.__treetime && window.__treetime.settled && window.__treetime.shown.length > 0);
}
// Wait until the map has finished loading whatever the current view needs.
export const settled = (page) => page.waitForFunction(() => window.__treetime && window.__treetime.settled);
export async function jumpTo(page, [lng, lat], zoom) {
  await page.evaluate(([x, y, z]) => window.__treetime.map.jumpTo({ center: [x, y], zoom: z }), [lng, lat, zoom]);
  await settled(page);
}
export const shownIds = (page) => page.evaluate(() => window.__treetime.shown.map((t) => t.id));
export async function clickTree(page, id) {
  // the dots are drawn off the main thread, and closing the sheet nudges the map:
  // wait until the map has caught up and is still
  await page.evaluate(() => new Promise((done) => {
    const { map } = window.__treetime;
    const check = () => (map.loaded() && map.isSourceLoaded('trees') && !map.isMoving() ? done() : setTimeout(check, 50));
    map.triggerRepaint(); check();
  }));
  const pt = await page.evaluate((tid) => {
    const { map, shown } = window.__treetime;
    const t = shown.find((x) => x.id === tid);
    if (!t) return null;
    const p = map.project([t.lng, t.lat]); const r = map.getContainer().getBoundingClientRect();
    return [r.x + p.x, r.y + p.y];
  }, id);
  if (!pt) throw new Error(`tree ${id} is not on the map`);
  // nothing (such as the sheet sliding shut) may be covering the dot
  await page.waitForFunction(([x, y]) => document.elementFromPoint(x, y)?.closest('#map'), pt);
  await page.mouse.click(pt[0], pt[1]);
}
export const pillText = async (page) => ((await page.locator('#pill').isVisible()) ? (await page.locator('#pill').innerText()).replace(/\s+/g, ' ').trim() : null);
