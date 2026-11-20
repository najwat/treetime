import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sdot } from '../../js/sources/sdot.js';
import { spr } from '../../js/sources/spr.js';
import { arcgisQueryAll, tileBBox, tileOf, tilesForBBox } from '../../js/sources/arcgis.js';
import { SOURCES, sourceOfTreeId } from '../../js/sources/index.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const SDOT_FX = fx('sdot-queen-anne.json').features;
const SPR_FX = fx('spr-queen-anne.json').features;
const TREE_KEYS = ['id', 'source', 'sourceId', 'common', 'scientific', 'genus', 'family', 'diameterIn', 'heightFt', 'lat', 'lng', 'planted', 'plantedYearOnly', 'place', 'placeKind', 'heritage', 'alsoIn'];

test('every source produces the same tree shape from real records', () => {
  for (const [source, feats] of [[sdot, SDOT_FX], [spr, SPR_FX]]) {
    const trees = feats.map((f) => source.normalize(f));
    assert.equal(trees.filter(Boolean).length, feats.length, `${source.id}: every fixture record normalizes`);
    for (const t of trees) {
      assert.deepEqual(Object.keys(t).sort(), [...TREE_KEYS].sort());
      assert.equal(t.source, source.id);
      assert.ok(t.id.startsWith(`${source.id}:`));
      assert.ok(t.diameterIn === null || (t.diameterIn > 0 && t.diameterIn <= 80));
      assert.ok(t.planted === null || /^\d{4}-\d\d-\d\d$/.test(t.planted));
    }
  }
});

test('SDOT adapter: fields map to the tree format', () => {
  const t = sdot.normalize({ attributes: { OBJECTID: 5, UNITID: 'TRE-73801', COMMON_NAME: 'Coast Redwood', SCIENTIFIC_NAME: 'Sequoia sempervirens', DIAM: 80, TREEHEIGHT: 0, UNITDESC: '1627 SUNSET AV SW', PLANTED_DATE: 717292800000, HERITAGE: 'Y' }, geometry: { x: -122.3917, y: 47.58866 } });
  assert.deepEqual({ ...t }, {
    id: 'sdot:TRE-73801', source: 'sdot', sourceId: 'TRE-73801', common: 'Coast Redwood', scientific: 'Sequoia sempervirens', genus: 'Sequoia', family: 'conifer',
    diameterIn: 80, heightFt: null, lat: 47.58866, lng: -122.3917, planted: '1992-09-24', plantedYearOnly: false, place: '1627 SUNSET AV SW', placeKind: 'address', heritage: true, alsoIn: [],
  });
});

test('SPR adapter: park name is the place; no planted date', () => {
  const t = spr.normalize({ attributes: { OBJECTID: 1, TREE_ID: 23759, PARK: 'Genesee Park and Playfield', COMMON: 'Black Cottonwood', SPECIES: 'Populus trichocarpa ', DBH_WL: 25, HEIGHT_WL: 45, STATUS: 'Existing' }, geometry: { x: -122.277177, y: 47.565684 } });
  assert.equal(t.id, 'spr:23759');
  assert.equal(t.place, 'Genesee Park and Playfield');
  assert.equal(t.placeKind, 'park');
  assert.equal(t.scientific, 'Populus trichocarpa');
  assert.equal(t.heightFt, 45);
  assert.equal(t.planted, null);
  assert.equal(t.heritage, false);
});

test('bad records are handled quietly', () => {
  assert.equal(sdot.normalize(null), null);
  assert.equal(sdot.normalize({ attributes: { UNITID: 'TRE-1' } }), null, 'no geometry');
  assert.equal(sdot.normalize({ attributes: { COMMON_NAME: 'Oak' }, geometry: { x: -122, y: 47 } }), null, 'no id');
  assert.equal(spr.normalize({ attributes: { TREE_ID: 7 }, geometry: { x: 'NaN', y: 47 } }), null, 'bad coordinates');
  const hawthorn = sdot.normalize({ attributes: { UNITID: 'TRE-2', COMMON_NAME: 'Unknown', SCIENTIFIC_NAME: null, DIAM: 555, PLANTED_DATE: 4102444800000 }, geometry: { x: -122.3, y: 47.6 } });
  assert.equal(hawthorn.diameterIn, null);
  assert.equal(hawthorn.common, null);
  assert.equal(hawthorn.planted, null);
  const park = spr.normalize({ attributes: { TREE_ID: 8, COMMON: null, SPECIES: null, DBH_WL: 280 }, geometry: { x: -122.3, y: 47.6 } });
  assert.equal(park.diameterIn, null);
  assert.equal(park.family, 'other');
});

test('where clauses: active filter, families, size, species', () => {
  assert.equal(sdot.where({}), "CURRENT_STATUS = 'INSVC'");
  assert.equal(spr.where({}), "STATUS = 'Existing'");
  assert.equal(sdot.where({ families: new Set(['maple']) }), "CURRENT_STATUS = 'INSVC' AND ((SCIENTIFIC_NAME = 'Acer' OR SCIENTIFIC_NAME LIKE 'Acer %'))");
  assert.equal(spr.where({ dmin: 18, dmax: 35 }), "STATUS = 'Existing' AND DBH_WL > 0 AND DBH_WL <= 80 AND DBH_WL >= 18 AND DBH_WL < 36");
  assert.equal(sdot.where({ dmin: 50, dmax: null }), "CURRENT_STATUS = 'INSVC' AND DIAM > 0 AND DIAM <= 80 AND DIAM >= 50");
  assert.equal(sdot.where({ species: "O'Brien Cherry" }), "CURRENT_STATUS = 'INSVC' AND UPPER(COMMON_NAME) = 'O''BRIEN CHERRY'");
  assert.match(sdot.where({ families: new Set(['other']) }), /SCIENTIFIC_NAME IS NULL OR NOT \(/);
  assert.equal(sdot.where({ species: 'Ginkgo' }, { species: false }), "CURRENT_STATUS = 'INSVC'");
});

test('pagination: keeps requesting until exceededTransferLimit stops', async () => {
  const calls = [];
  const pages = [{ features: [1, 2, 3].map((n) => ({ n })), exceededTransferLimit: true }, { features: [4, 5, 6].map((n) => ({ n })), exceededTransferLimit: true }, { features: [{ n: 7 }] }];
  const fetchImpl = async (url) => { calls.push(new URL(url).searchParams.get('resultOffset')); return { ok: true, json: async () => pages[calls.length - 1] }; };
  const all = await arcgisQueryAll('https://example.test/layer', { where: '1=1' }, { fetchImpl });
  assert.deepEqual(all.map((f) => f.n), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(calls, [null, '3', '6']);
});

test('pagination: a service error is thrown, not swallowed', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ error: { message: 'Invalid query' } }) });
  await assert.rejects(arcgisQueryAll('https://example.test/layer', {}, { fetchImpl }), /Invalid query/);
});

test('tile maths round-trips', () => {
  const [x, y] = tileOf(-122.3125, 47.6236, 14);
  assert.deepEqual([x, y], [2625, 5720]);
  const [w, s, e, n] = tileBBox(14, x, y);
  assert.ok(w < -122.3125 && e > -122.3125 && s < 47.6236 && n > 47.6236);
  assert.equal(tilesForBBox([w + 1e-6, s + 1e-6, e - 1e-6, n - 1e-6], 14).length, 1);
  assert.equal(tilesForBBox([w - 1e-6, s - 1e-6, e + 1e-6, n + 1e-6], 14).length, 9);
});

test('source registry', () => {
  assert.deepEqual(SOURCES.map((s) => s.id), ['sdot', 'spr']);
  assert.equal(sourceOfTreeId('spr:42').id, 'spr');
  assert.equal(sourceOfTreeId('nope:1'), null);
  for (const s of SOURCES) for (const k of ['label', 'publisher', 'credit', 'covers', 'infoUrl']) assert.ok(s[k], `${s.id}.${k}`);
});
