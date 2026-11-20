import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');
const components = css.slice(css.indexOf('/* ---------- 3. components'));
const read = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

test('components use tokens: no hex colours and no raw type sizes', () => {
  assert.ok(components.length > 1000);
  assert.deepEqual(components.match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
  assert.deepEqual(components.match(/font(?:-size)?:[^;}]*?\b[\d.]+px/g) || [], []);
});

test('no hex colours in the page or the scripts', () => {
  for (const f of ['index.html', 'js/app.js', 'js/tree.js']) {
    const text = read(f).replace(/&#\w+;/g, '');
    assert.deepEqual(text.match(/#[0-9a-fA-F]{6}\b/g) || [], [], f);
  }
});

test('every token used is defined, and dark defines the same colour tokens in both places', () => {
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const setByScript = new Set(['--sheet-visible', '--c']);
  assert.deepEqual([...used].filter((v) => !defined.has(v) && !setByScript.has(v)), []);
  const blocks = [...css.matchAll(/(?:data-theme="light"\]\)|data-theme="dark"\])\{([^}]*)\}/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0], blocks[1]);
});

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('text and control colours meet WCAG AA in light and dark', () => {
  const palette = Object.fromEntries([...css.matchAll(/(--[\w-]+):(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
  const light = css.slice(css.indexOf('/* ---------- 2. semantic'), css.indexOf('@media (prefers-color-scheme: dark)'));
  const dark = css.match(/data-theme="dark"\]\{([^}]*)\}/)[1];
  for (const [name, block] of [['light', light], ['dark', dark]]) {
    const t = Object.fromEntries([...block.matchAll(/(--[\w-]+):var\((--[\w-]+)\)/g)].map((m) => [m[1], palette[m[2]]]));
    const pairs = [
      ['--content-primary', '--surface-raised', 4.5], ['--content-primary', '--surface-chip', 4.5], ['--content-primary', '--surface-page', 4.5],
      ['--content-secondary', '--surface-raised', 4.5], ['--content-secondary', '--surface-chip', 4.5], ['--content-secondary', '--surface-page', 4.5],
      ['--content-secondary', '--surface-map', 4.5], ['--accent', '--surface-raised', 4.5], ['--accent-content', '--accent', 4.5],
      ['--control-border-color', '--surface-raised', 3], ['--accent', '--surface-raised', 3],
    ];
    for (const [fg, bg, min] of pairs) {
      assert.ok(t[fg] && t[bg], `${name}: ${fg} and ${bg} resolve`);
      assert.ok(contrast(t[fg], t[bg]) >= min, `${name}: ${fg} on ${bg} is ${contrast(t[fg], t[bg]).toFixed(2)}, needs ${min}`);
    }
  }
});
