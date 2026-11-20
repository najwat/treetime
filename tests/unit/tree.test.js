import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDiameter, cleanHeight, cleanName, cleanPlanted, familyOf, formatPlanted, genusOf, makeTree, matches, treeName } from '../../js/tree.js';

const NOW = Date.UTC(2026, 10, 20);
const base = { source: 'sdot', sourceId: 'TRE-1', lat: 47.6, lng: -122.3, now: NOW };

test('diameters over 80 in, zero, negative and junk are "not recorded"', () => {
  assert.equal(cleanDiameter(80), 80);
  assert.equal(cleanDiameter(12.5), 12.5);
  for (const bad of [81, 555, 999, 0, -3, null, undefined, '', 'big', NaN]) assert.equal(cleanDiameter(bad), null, String(bad));
});

test('heights: zero and impossible values are dropped', () => {
  assert.equal(cleanHeight(45), 45);
  for (const bad of [0, null, 301, 9999, 'x']) assert.equal(cleanHeight(bad), null);
});

test('planted dates: future and pre-1850 dates are dropped; Jan 1 means the year only', () => {
  assert.deepEqual(cleanPlanted(Date.UTC(1992, 8, 24), NOW), { planted: '1992-09-24', plantedYearOnly: false });
  assert.deepEqual(cleanPlanted(Date.UTC(1955, 0, 1), NOW), { planted: '1955-01-01', plantedYearOnly: true });
  assert.equal(cleanPlanted(Date.UTC(2027, 8, 12), NOW).planted, null, 'future date (the SDOT layer has one in 2027)');
  assert.equal(cleanPlanted(Date.UTC(1700, 0, 1), NOW).planted, null);
  for (const bad of [null, undefined, '', 'yesterday', NaN]) assert.equal(cleanPlanted(bad, NOW).planted, null);
});

test('placeholder names count as missing', () => {
  assert.equal(cleanName('  Red   Maple '), 'Red Maple');
  for (const bad of ['Unknown', 'unknown', '', '  ', 'N/A', null, undefined]) assert.equal(cleanName(bad), null);
});

test('genus and family come from the scientific name', () => {
  assert.equal(genusOf('Acer rubrum `Red Sunset`'), 'Acer');
  assert.equal(genusOf('x Cupressocyparis leylandii'), 'Cupressocyparis');
  assert.equal(genusOf('  quercus rubra'), 'Quercus');
  assert.equal(genusOf(null), null);
  assert.equal(genusOf('?? sp'), null);
  assert.equal(familyOf('Pseudotsuga menziesii'), 'conifer');
  assert.equal(familyOf('Platanus x acerifolia'), 'other');
  assert.equal(familyOf(null), 'other');
});

test('makeTree cleans a messy record without throwing', () => {
  const t = makeTree({ ...base, common: 'Unknown', scientific: ' Crataegus  laevigata ', diameter: 555, height: 0, plantedMs: Date.UTC(2027, 0, 1), place: ' 12 OAK ST ', heritage: true });
  assert.equal(t.id, 'sdot:TRE-1');
  assert.equal(t.common, null);
  assert.equal(t.scientific, 'Crataegus laevigata');
  assert.equal(t.genus, 'Crataegus');
  assert.equal(t.diameterIn, null);
  assert.equal(t.heightFt, null);
  assert.equal(t.planted, null);
  assert.equal(t.place, '12 OAK ST');
  assert.equal(t.heritage, true);
  assert.equal(treeName(t), 'Crataegus laevigata');
  assert.equal(treeName(makeTree({ ...base })), 'Unknown species');
});

test('records with no id or no usable location are rejected', () => {
  assert.equal(makeTree({ ...base, sourceId: null }), null);
  assert.equal(makeTree({ ...base, sourceId: '  ' }), null);
  assert.equal(makeTree({ ...base, lat: null }), null);
  assert.equal(makeTree({ ...base, lat: 'abc' }), null);
  assert.equal(makeTree({ ...base, lat: 0, lng: 0 }), null);
  assert.equal(makeTree({ ...base, lat: 147 }), null);
});

test('formatPlanted shows only the year for Jan 1 dates', () => {
  assert.equal(formatPlanted(makeTree({ ...base, plantedMs: Date.UTC(1955, 0, 1) }), 'en-US'), '1955');
  assert.equal(formatPlanted(makeTree({ ...base, plantedMs: Date.UTC(1992, 8, 24) }), 'en-US'), 'Sep 24, 1992');
  assert.equal(formatPlanted(makeTree({ ...base }), 'en-US'), null);
});

test('matches(): family, size and species filters', () => {
  const maple = makeTree({ ...base, common: 'Red Maple', scientific: 'Acer rubrum', diameter: 20 });
  const unknownSize = makeTree({ ...base, sourceId: 'TRE-2', common: 'Red Maple', scientific: 'Acer rubrum', diameter: 999 });
  assert.ok(matches(maple, {}));
  assert.ok(matches(maple, { families: new Set(['maple']) }));
  assert.ok(!matches(maple, { families: new Set(['oak']) }));
  assert.ok(matches(maple, { dmin: 18, dmax: 35 }));
  assert.ok(!matches(maple, { dmin: 36, dmax: 49 }));
  assert.ok(matches(maple, { dmin: 0, dmax: 20 }), 'dmax is inclusive of whole inches');
  assert.ok(matches(maple, { dmin: 18, dmax: null }));
  assert.ok(matches(unknownSize, {}), 'no size filter: unrecorded sizes still show');
  assert.ok(!matches(unknownSize, { dmin: 0, dmax: 5 }), 'any size filter excludes unrecorded sizes');
  assert.ok(matches(maple, { species: 'red maple' }));
  assert.ok(!matches(maple, { species: 'Norway Maple' }));
});
