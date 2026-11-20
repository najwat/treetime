import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEGACY_CRUSHES_KEY, LEGACY_FAVORITES_KEY, SAVED_KEY, findSaved, loadSaved, migrateLegacy, writeSaved } from '../../js/saved.js';
import { sdot } from '../../js/sources/sdot.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url)));
const FROM_APP = fx('saved-v1-from-app.json').favoriteTrees;
const SHAPES = fx('saved-legacy-shapes.json');
const normalize = (f) => sdot.normalize(f);
const NOW = Date.UTC(2026, 10, 20);
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test('saves written by the current app migrate with nothing lost', () => {
  const storage = fakeStorage({ [LEGACY_FAVORITES_KEY]: JSON.stringify(FROM_APP) });
  const { records, migrated } = loadSaved(storage, normalize, NOW);
  assert.equal(migrated, true);
  assert.equal(records.length, FROM_APP.length);
  for (const old of FROM_APP) {
    const rec = records.find((r) => r.id === `sdot:${old.a.UNITID}`);
    assert.ok(rec, `${old.key} survives as sdot:${old.a.UNITID}`);
    assert.equal(rec.name, old.name);
    assert.equal(rec.since, old.since);
    assert.equal(rec.savedAt, old.savedAt);
    assert.equal(rec.tree.common, old.a.COMMON_NAME);
    assert.equal(rec.tree.place, old.a.UNITDESC);
    assert.equal(rec.tree.lat, old.g.y);
    assert.equal(rec.tree.lng, old.g.x);
  }
  const named = records.find((r) => r.name);
  assert.equal(named.name, 'Mr. O’Leary 🌳', 'apostrophes and emoji survive');
  assert.deepEqual(records.map((r) => r.id), FROM_APP.slice().sort((a, b) => b.savedAt - a.savedAt).map((o) => `sdot:${o.a.UNITID}`), 'newest first');
});

test('migration keeps the old data in place and is not repeated', () => {
  const storage = fakeStorage({ [LEGACY_FAVORITES_KEY]: JSON.stringify(FROM_APP) });
  const first = loadSaved(storage, normalize, NOW);
  assert.equal(storage.getItem(LEGACY_FAVORITES_KEY), JSON.stringify(FROM_APP), 'legacy key untouched (a rollback still works)');
  assert.ok(storage.getItem(SAVED_KEY));
  // the user removes a tree in v2; reloading must not resurrect it from the legacy key
  writeSaved(storage, first.records.slice(1));
  const second = loadSaved(storage, normalize, NOW);
  assert.equal(second.migrated, false);
  assert.equal(second.records.length, FROM_APP.length - 1);
});

test('older shapes: first-version favorites, OBJECTID keys, and the crushes store', () => {
  const records = migrateLegacy({ favorites: [...SHAPES.favoritesFirstVersion, ...SHAPES.oidKeyed, ...SHAPES.garbage], crushes: SHAPES.crushes }, normalize, NOW);
  const chestnut = records.find((r) => r.id === 'sdot:TRE-33477');
  assert.ok(chestnut, 'keyed by UNITID');
  assert.equal(chestnut.name, 'Conker', 'the name from the crushes store is kept');
  assert.equal(chestnut.since, 1760000000000, 'earliest "since" wins');
  assert.equal(chestnut.tree.planted, '1955-01-01');
  const legacy = records.find((r) => r.id.startsWith('sdot:legacy-'));
  assert.ok(legacy, 'a record with no UNITID still loads, under a legacy id');
  assert.equal(legacy.tree.common, 'Red Maple');
  assert.equal(legacy.tree.diameterIn, null, 'the 999 in diameter is cleaned on the way in');
  assert.equal(legacy.since, legacy.savedAt, 'missing "since" falls back to the saved date');
  assert.ok(!records.some((r) => r.id === 'sdot:TRE-9'), 'an un-hearted crush is not restored');
  assert.equal(records.length, 2, 'garbage entries are skipped quietly');
});

test('loadSaved never throws: broken JSON, missing storage, wrong types', () => {
  assert.deepEqual(loadSaved(fakeStorage({ [LEGACY_FAVORITES_KEY]: '{not json' }), normalize, NOW).records, []);
  assert.deepEqual(loadSaved(fakeStorage({ [SAVED_KEY]: '"a string"' }), normalize, NOW).records, []);
  assert.deepEqual(loadSaved({ getItem() { throw new Error('denied'); } }, normalize, NOW).records, []);
  assert.deepEqual(loadSaved(fakeStorage({ [LEGACY_CRUSHES_KEY]: '[null, 3]' }), normalize, NOW).records, []);
  assert.equal(writeSaved({ setItem() { throw new Error('full'); } }, []), false);
});

test('v2 records round-trip and tolerate missing optional fields', () => {
  const storage = fakeStorage();
  const tree = sdot.normalize({ attributes: { UNITID: 'TRE-5', COMMON_NAME: 'Ginkgo' }, geometry: { x: -122.3, y: 47.6 } });
  writeSaved(storage, [{ id: tree.id, tree, savedAt: 5, since: 3, name: 'Zoë 🌳', gone: false }, { id: 'spr:9', tree: { ...tree, id: 'spr:9', source: 'spr' } }]);
  const { records } = loadSaved(storage, normalize, NOW);
  assert.equal(records[0].name, 'Zoë 🌳');
  assert.equal(records[1].name, '');
  assert.equal(records[1].gone, false);
  assert.equal(records[1].since, NOW);
});

test('findSaved: a saved id stays valid when its tree is later shown under a duplicate', () => {
  const saved = [{ id: 'spr:15348', tree: {}, name: 'Conker' }];
  const shown = { id: 'sdot:TRE-33477', alsoIn: [{ id: 'spr:15348', source: 'spr' }] };
  assert.equal(findSaved(saved, shown).name, 'Conker');
  assert.equal(findSaved(saved, { id: 'sdot:TRE-1', alsoIn: [] }), null);
  assert.equal(findSaved(saved, null), null);
});
