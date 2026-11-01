#!/usr/bin/env node
// Build drifting.cc's landing page as a static directory:
//   node scripts/design-assets/landing/build.mjs [out-dir] [--og card.png]
// Writes index.html, assets/ (the script bundle, masks and icons) and fonts/
// (out/landing by default), replacing only those; --og copies the sharing card
// in as og.png. Point it at the site's served directory to update the page.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const args = process.argv.slice(2);
const ogAt = args.indexOf('--og');
const og = ogAt >= 0 ? path.resolve(args[ogAt + 1]) : null;
const [outArg] = args.filter((arg, index) => !arg.startsWith('--') && !(ogAt >= 0 && index === ogAt + 1));
const out = path.resolve(outArg ?? path.join(root, 'out/landing'));

// Only what this script writes is replaced: the site's own pages beside it stay.
for (const own of ['index.html', 'assets', 'fonts', 'og.png']) rmSync(path.join(out, own), { recursive: true, force: true });
mkdirSync(path.join(out, 'assets'), { recursive: true });
mkdirSync(path.join(out, 'fonts'), { recursive: true });

// The script: the sea, frame and cover straight from the app's source.
await build({
  entryPoints: [path.join(here, 'entry.mjs')],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  outfile: path.join(out, 'assets/landing.js'),
  loader: { '.png': 'file' },
  assetNames: '[name]',
  publicPath: '/assets/',
  legalComments: 'none',
  logLevel: 'warning',
});

// The masks and icons the page names, each copied once.
let page = readFileSync(path.join(here, 'index.html'), 'utf8');
const design = path.join(root, 'src/assets/design');
page = page.replace(/\{\{asset:([^}]+)\}\}/g, (_, rel) => {
  const name = rel.replaceAll('/', '-');
  copyFileSync(path.join(design, rel), path.join(out, 'assets', name));
  return `/assets/${name}`;
});

// The fonts, served from the site so a visit asks nothing of another host:
// only the slices of each face that hold a character the page or the sea
// writes. The families keep the app's names, so the sea's own font stacks
// (char-sea-text.ts) find them.
const written = page + readFileSync(path.join(root, 'src/renderer/lib/char-sea/char-sea-text.ts'), 'utf8');
const used = [...new Set([...written].map((char) => char.codePointAt(0)))];
const covers = (ranges) => ranges.split(',').some((range) => {
  const [from, to = from] = range.trim().replace(/^U\+/i, '').split('-');
  const lo = parseInt(from.replace(/\?/g, '0'), 16);
  const hi = parseInt(to.replace(/\?/g, 'F'), 16);
  return used.some((point) => point >= lo && point <= hi);
});
let faces = '';
for (const face of ['inter-tight', 'newsreader', 'noto-serif-sc']) {
  const dir = path.join(root, 'node_modules/@fontsource-variable', face);
  // The faces are under the SIL Open Font License, which travels with the files.
  copyFileSync(path.join(dir, 'LICENSE'), path.join(out, 'fonts', `${face}-LICENSE.txt`));
  for (const rule of readFileSync(path.join(dir, 'index.css'), 'utf8').match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    if (!/font-style:\s*normal/.test(rule)) continue;
    const ranges = /unicode-range:\s*([^;]+);/.exec(rule)?.[1];
    if (ranges && !covers(ranges)) continue;
    faces += `${rule.replace(/url\(\.\/files\/([^)]+)\)/g, (_, file) => {
      copyFileSync(path.join(dir, 'files', file), path.join(out, 'fonts', file));
      return `url(/fonts/${file})`;
    })}\n`;
  }
}
page = page.replace('{{fonts}}', faces);

const left = page.match(/\{\{[^}]*\}\}/);
if (left) throw new Error(`build.mjs: unfilled placeholder ${left[0]}`);
if (og) copyFileSync(og, path.join(out, 'og.png'));
writeFileSync(path.join(out, 'index.html'), page);

const size = (dir) => readdirSync(dir).reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0);
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
console.log(`${out}
  index.html  ${kb(statSync(path.join(out, 'index.html')).size)}
  assets/     ${readdirSync(path.join(out, 'assets')).length} files, ${kb(size(path.join(out, 'assets')))}
  fonts/      ${readdirSync(path.join(out, 'fonts')).length} files, ${kb(size(path.join(out, 'fonts')))}${og ? '\n  og.png' : ''}`);
