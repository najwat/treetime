// What the app should show for the fixtures, computed with the app's own modules.
import { loadFixtures } from './mock.js';
import { sdot } from '../../js/sources/sdot.js';
import { spr } from '../../js/sources/spr.js';
import { dedupe } from '../../js/dedupe.js';
import { matches } from '../../js/tree.js';

const fx = loadFixtures();
export const street = fx.sdot.filter((f) => f.attributes.CURRENT_STATUS === 'INSVC').map((f) => sdot.normalize(f));
export const park = fx.spr.filter((f) => f.attributes.STATUS === 'Existing').map((f) => spr.normalize(f));
export const all = [...street, ...park];
export const unique = (trees) => dedupe(trees, { order: ['sdot', 'spr'] }).trees;
export const count = (trees, f = {}) => trees.filter((t) => matches(t, f)).length;
export const fmt = (n) => new Intl.NumberFormat('en-US').format(n);
