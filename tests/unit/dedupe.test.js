import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dedupe, metersBetween } from '../../js/dedupe.js';
import { makeTree } from '../../js/tree.js';
import { sdot } from '../../js/sources/sdot.js';
import { spr } from '../../js/sources/spr.js';

const M = 1 / 111320; // degrees of latitude per metre
const tree = (source, id, lat, lng, scientific, extra = {}) => makeTree({ source, sourceId: id, lat, lng, scientific, ...extra });
const order = ['sdot', 'spr'];

test('same genus within 3 m across sources is one tree; the more detailed record wins', () => {
  const a = tree('sdot', 'TRE-1', 47.64, -122.35, 'Aesculus hippocastanum', { diameter: 30, place: '1 A ST', plantedMs: 0 });
  const b = tree('spr', '15348', 47.64 + 2 * M, -122.35, 'Aesculus hippocastanum', { diameter: 31, place: 'Queen Anne Boulevard' });
  const { trees, replaced } = dedupe([a, b], { order });
  assert.equal(trees.length, 1);
  assert.equal(trees[0].id, 'sdot:TRE-1');
  assert.deepEqual(trees[0].alsoIn, [{ id: 'spr:15348', source: 'spr' }]);
  assert.equal(replaced.get('spr:15348'), 'sdot:TRE-1');
  assert.deepEqual(a.alsoIn, [], 'inputs are not mutated');
});

test('different genus, same source, or too far apart are separate trees', () => {
  const a = tree('sdot', 'TRE-1', 47.64, -122.35, 'Acer rubrum');
  assert.equal(dedupe([a, tree('spr', '1', 47.64 + 1 * M, -122.35, 'Prunus serrulata')], { order }).trees.length, 2, 'different genus');
  assert.equal(dedupe([a, tree('sdot', 'TRE-2', 47.64 + 1 * M, -122.35, 'Acer rubrum')], { order }).trees.length, 2, 'same source');
  assert.equal(dedupe([a, tree('spr', '1', 47.64 + 3.5 * M, -122.35, 'Acer rubrum')], { order }).trees.length, 2, '3.5 m apart');
});

test('with a missing genus, only near-identical positions (1 m) match', () => {
  const a = tree('sdot', 'TRE-1', 47.64, -122.35, 'Acer rubrum');
  assert.equal(dedupe([a, tree('spr', '1', 47.64 + 0.5 * M, -122.35, null)], { order }).trees.length, 1);
  assert.equal(dedupe([a, tree('spr', '1', 47.64 + 2 * M, -122.35, null)], { order }).trees.length, 2);
});

test('pairing is one-to-one and independent of input order', () => {
  const a = tree('sdot', 'TRE-1', 47.64, -122.35, 'Acer rubrum', { diameter: 10 });
  const p1 = tree('spr', '1', 47.64 + 1 * M, -122.35, 'Acer macrophyllum');
  const p2 = tree('spr', '2', 47.64 + 2 * M, -122.35, 'Acer macrophyllum');
  const r1 = dedupe([a, p1, p2], { order }), r2 = dedupe([p2, p1, a], { order });
  assert.equal(r1.trees.length, 2);
  assert.deepEqual(r1.trees.map((t) => t.id).sort(), r2.trees.map((t) => t.id).sort());
  assert.equal(r1.replaced.get('spr:1'), 'sdot:TRE-1', 'the nearer park record is the duplicate');
});

test('a tie on detail goes to the first source in `order`; a richer park record can win', () => {
  const a = tree('sdot', 'TRE-1', 47.64, -122.35, 'Acer rubrum');
  const b = tree('spr', '1', 47.64, -122.35, 'Acer rubrum');
  assert.equal(dedupe([b, a], { order }).trees[0].id, 'sdot:TRE-1');
  const rich = tree('spr', '2', 47.64, -122.35, 'Acer rubrum', { diameter: 20, height: 40, place: 'Some Park', common: 'Red Maple' });
  assert.equal(dedupe([a, rich], { order }).trees[0].id, 'spr:2');
});

test('one source alone is returned unchanged and stale alsoIn is cleared', () => {
  const a = { ...tree('sdot', 'TRE-1', 47.64, -122.35, 'Acer rubrum'), alsoIn: [{ id: 'spr:1', source: 'spr' }] };
  const out = dedupe([a], { order }).trees;
  assert.deepEqual(out[0].alsoIn, []);
});

test('real data: the Queen Anne Boulevard fixture contains street/park duplicates', () => {
  const fx = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url))).features;
  const st = fx('sdot-queen-anne.json').filter((f) => f.attributes.CURRENT_STATUS === 'INSVC').map((f) => sdot.normalize(f));
  const pk = fx('spr-queen-anne.json').filter((f) => f.attributes.STATUS === 'Existing').map((f) => spr.normalize(f));
  const { trees, replaced } = dedupe([...st, ...pk], { order });
  assert.ok(replaced.size >= 5, `expected several duplicates, found ${replaced.size}`);
  assert.equal(trees.length, st.length + pk.length - replaced.size);
  for (const t of trees.filter((x) => x.alsoIn.length)) {
    const other = [...st, ...pk].find((x) => x.id === t.alsoIn[0].id);
    assert.ok(metersBetween(t, other) <= 3);
    assert.equal(t.genus, other.genus);
  }
  assert.ok(trees.some((t) => t.id === 'sdot:TRE-33477' && t.alsoIn[0]?.id === 'spr:15348'), 'the known horse chestnut pair is matched');
});
