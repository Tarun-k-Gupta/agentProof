// prepack: rewrite entry points to dist for the published tarball.
// npm ignores `exports` inside publishConfig (warns "Unknown publishConfig
// config"), so the dev manifest (src-first, for workspace tsx consumption)
// is rewritten here instead. postpack restores it. The backup file is not
// matched by `files`, so it never ships.
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';

const MANIFEST = new URL('../package.json', import.meta.url);
const BACKUP = new URL('../package.json.prepack-bak', import.meta.url);

if (process.argv[2] === 'restore') {
  if (existsSync(BACKUP)) {
    copyFileSync(BACKUP, MANIFEST);
    unlinkSync(BACKUP);
    console.log('publish manifest restored');
  }
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(MANIFEST, 'utf8'));
copyFileSync(MANIFEST, BACKUP);

const dist = (p) => `./dist/${p}.js`;
const distTypes = (p) => `./dist/${p}.d.ts`;
const entry = (p) => ({ types: distTypes(p), import: dist(p) });

pkg.main = './dist/index.js';
pkg.types = './dist/index.d.ts';
pkg.exports = {
  '.': entry('index'),
  './calldata': entry('testing/calldata'),
  './decode/uniswap': entry('decode/uniswapV4'),
  './testing': entry('testing/SimulatedAccount'),
  './adapters': entry('adapters/index'),
};
delete pkg.publishConfig;

writeFileSync(MANIFEST, JSON.stringify(pkg, null, 2) + '\n');
console.log('publish manifest written (backup at package.json.prepack-bak)');
