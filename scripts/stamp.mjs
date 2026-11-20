// Stamps index.html with a content hash for every stylesheet and script module, so a
// browser can never pair a fresh page with a stale cached file (GitHub Pages lets
// browsers cache each file for 10 minutes). Module imports are versioned through the
// import map. Run after changing style.css or anything in js/:  npm run stamp
// `node scripts/stamp.mjs --check` exits 1 if index.html is out of date (used by tests).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = (file) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex').slice(0, 10);
const walk = (dir) => readdirSync(join(root, dir)).flatMap((n) => {
  const p = join(dir, n);
  return statSync(join(root, p)).isDirectory() ? walk(p) : p.endsWith('.js') ? [p.split('\\').join('/')] : [];
});

export function stamped(html) {
  const modules = walk('js').sort();
  const imports = Object.fromEntries(modules.filter((m) => m !== 'js/app.js').map((m) => [`./${m}`, `./${m}?v=${hash(m)}`]));
  return html
    .replace(/<script type="importmap" id="importmap">[\s\S]*?<\/script>/, `<script type="importmap" id="importmap">${JSON.stringify({ imports })}</script>`)
    .replace(/(<script type="module" src="js\/app\.js)(\?v=[^"]*)?(")/, `$1?v=${hash('js/app.js')}$3`)
    .replace(/(href="style\.css)(\?v=[^"]*)?(")/, `$1?v=${hash('style.css')}$3`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = join(root, 'index.html');
  const before = readFileSync(file, 'utf8');
  const after = stamped(before);
  if (process.argv.includes('--check')) {
    if (before !== after) { console.error('index.html is out of date: run `npm run stamp`'); process.exit(1); }
    console.log('index.html asset versions are up to date');
  } else if (before !== after) { writeFileSync(file, after); console.log('stamped', relative(root, file)); }
  else console.log('already up to date');
}
