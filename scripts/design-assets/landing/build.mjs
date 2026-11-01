#!/usr/bin/env node
// Build drifting.cc's home page and the look its other pages share:
//   node scripts/design-assets/landing/build.mjs [out-dir] [--og card.png]
// Writes index.html, assets/ (site.css, prefs.js, the landing and information
// page scripts, masks and icons) and fonts/ (out/landing by default),
// replacing only those; --og copies the sharing card in as og.png. Point it at
// the site's served directory to update the site: the information pages there
// link /assets/site.css, /assets/prefs.js and /assets/pages.js.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const args = process.argv.slice(2);
const ogAt = args.indexOf('--og');
const og = ogAt >= 0 ? path.resolve(args[ogAt + 1]) : null;
const [outArg] = args.filter((arg, index) => !arg.startsWith('--') && !(ogAt >= 0 && index === ogAt + 1));
const out = path.resolve(outArg ?? path.join(root, 'out/landing'));

// Only what this script writes is replaced: the site's own pages beside it stay,
// and so does the sharing card unless a new one is given.
for (const own of ['index.html', 'assets', 'fonts', ...(og ? ['og.png'] : [])]) rmSync(path.join(out, own), { recursive: true, force: true });
mkdirSync(path.join(out, 'assets'), { recursive: true });
mkdirSync(path.join(out, 'fonts'), { recursive: true });

// The scripts: the sea, frame and cover straight from the app's source, and
// the bar every page shares (site.mjs).
await build({
  entryPoints: { landing: path.join(here, 'entry.mjs'), pages: path.join(here, 'pages.mjs') },
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  outdir: path.join(out, 'assets'),
  loader: { '.png': 'file' },
  assetNames: '[name]',
  publicPath: '/assets/',
  legalComments: 'none',
  logLevel: 'warning',
});
copyFileSync(path.join(here, 'prefs.js'), path.join(out, 'assets/prefs.js'));

// The masks and icons the page and the shared sheet name, each copied once.
const design = path.join(root, 'src/assets/design');
const withAssets = (text) => text.replace(/\{\{asset:([^}]+)\}\}/g, (_, rel) => {
  const name = rel.replaceAll('/', '-');
  copyFileSync(path.join(design, rel), path.join(out, 'assets', name));
  return `/assets/${name}`;
});
let page = withAssets(readFileSync(path.join(here, 'index.html'), 'utf8'));
let css = withAssets(readFileSync(path.join(here, 'site.css'), 'utf8'));

// The fonts, served from the site so a visit asks nothing of another host:
// only the slices of each face that hold a character a page or the sea
// writes — this page, and the site's information pages already in the
// directory. The families keep the app's names, so the sea's own font stacks
// (char-sea-text.ts) find them.
const others = readdirSync(out).filter((name) => name.endsWith('.html') && name !== 'index.html');
const written = [page, readFileSync(path.join(root, 'src/renderer/lib/char-sea/char-sea-text.ts'), 'utf8'),
  ...others.map((name) => readFileSync(path.join(out, name), 'utf8'))].join('');
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
css = css.replace('{{fonts}}', faces);

for (const [name, text] of [['index.html', page], ['site.css', css]]) {
  const left = text.match(/\{\{[^}]*\}\}/);
  if (left) throw new Error(`build.mjs: unfilled placeholder ${left[0]} in ${name}`);
}
if (og) copyFileSync(og, path.join(out, 'og.png'));
writeFileSync(path.join(out, 'assets/site.css'), css);
writeFileSync(path.join(out, 'index.html'), page);
for (const name of others) {
  const text = readFileSync(path.join(out, name), 'utf8');
  for (const asset of ['/assets/site.css', '/assets/prefs.js', '/assets/pages.js']) {
    if (text.includes(asset) && !existsSync(path.join(out, asset))) throw new Error(`build.mjs: ${name} links ${asset}, which was not written`);
  }
}

const size = (dir) => readdirSync(dir).reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0);
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
console.log(`${out}
  index.html  ${kb(statSync(path.join(out, 'index.html')).size)}
  assets/     ${readdirSync(path.join(out, 'assets')).length} files, ${kb(size(path.join(out, 'assets')))}
  fonts/      ${readdirSync(path.join(out, 'fonts')).length} files, ${kb(size(path.join(out, 'fonts')))}${og ? '\n  og.png' : ''}${others.length ? `\n  fonts cover ${others.join(', ')}` : ''}`);
