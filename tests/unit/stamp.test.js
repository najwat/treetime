import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stamped } from '../../scripts/stamp.mjs';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

test('index.html asset versions match the files (run `npm run stamp` after editing js/ or style.css)', () => {
  assert.equal(stamped(html), html);
});

test('every module is versioned through the import map', () => {
  const map = JSON.parse(html.match(/<script type="importmap" id="importmap">([\s\S]*?)<\/script>/)[1]).imports;
  const walk = (dir) => readdirSync(new URL(`../../${dir}/`, import.meta.url), { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : d.name.endsWith('.js') ? [`./${dir}/${d.name}`] : []));
  for (const m of walk('js').filter((x) => x !== './js/app.js')) assert.match(map[m] || '', /\?v=[0-9a-f]{10}$/, m);
  assert.match(html, /<script type="module" src="js\/app\.js\?v=[0-9a-f]{10}">/);
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'), 'the import map must come before the module script');
});
