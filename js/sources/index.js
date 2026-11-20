// The sources TreeTime draws from, in display order. The first source wins ties
// when two records are judged to be the same tree.
import { sdot } from './sdot.js';
import { spr } from './spr.js';

export const SOURCES = [sdot, spr];
export const SOURCE_IDS = SOURCES.map((s) => s.id);
export const sourceById = (id) => SOURCES.find((s) => s.id === id) || null;
export const sourceOfTreeId = (treeId) => sourceById(String(treeId).split(':')[0]);
