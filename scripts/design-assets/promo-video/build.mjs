#!/usr/bin/env node
// Build the promo video's page:
//   node scripts/design-assets/promo-video/build.mjs [out-dir] [--lang en|zh]
// Writes index.html, assets/ and fonts/ (out/promo-video/page by default).
// The corners of the workspace and their styles are taken from the landing
// page's own index.html, in the landing's copy for --lang, and site.css is
// the landing's, so the video shows what drifting.cc shows. render.mjs
// serves the directory and captures it, building it again for each language.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const landing = path.join(here, '../landing');
const args = process.argv.slice(2);
const langAt = args.indexOf('--lang');
const lang = langAt >= 0 && args[langAt + 1] === 'zh' ? 'zh' : 'en';
const [outArg] = args.filter((arg, index) => !arg.startsWith('--') && !(langAt >= 0 && index === langAt + 1));
const out = path.resolve(outArg ?? path.join(root, 'out/promo-video/page'));

// The landing page's own placeholders inside the corners, filled as its build
// fills them for the locale: the copy, the CJK script marker and short dates.
const locale = lang === 'zh' ? 'zh-CN' : 'en';
const strings = JSON.parse(readFileSync(path.join(landing, 'copy', `${locale}.json`), 'utf8'));
const localize = (text) => text.replace(/\{\{(copy:[^}]+|cjk-attr|date:[^}]+)\}\}/g, (token, key) => {
  if (key === 'cjk-attr') return lang === 'zh' ? ' data-script="cjk"' : '';
  if (key.startsWith('date:')) {
    const [month, day] = key.slice(5).split('-').map(Number);
    return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2026, month - 1, day));
  }
  return strings[key.slice(5)] ?? token;
});

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'assets'), { recursive: true });
mkdirSync(path.join(out, 'fonts'), { recursive: true });

await build({
  entryPoints: { video: path.join(here, 'video.mjs') },
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outdir: path.join(out, 'assets'),
  loader: { '.png': 'file' },
  assetNames: '[name]',
  publicPath: '/assets/',
  legalComments: 'none',
  logLevel: 'warning',
});
copyFileSync(path.join(here, 'clock.js'), path.join(out, 'assets/clock.js'));

const design = path.join(root, 'src/assets/design');
const withAssets = (text) => text.replace(/\{\{asset:([^}]+)\}\}/g, (_, rel) => {
  const name = rel.replaceAll('/', '-');
  copyFileSync(path.join(design, rel), path.join(out, 'assets', name));
  return `/assets/${name}`;
});

// The landing page's <style> and each corner (`<div class="vg …" id="…">`), as written there.
const home = localize(readFileSync(path.join(landing, 'index.html'), 'utf8'));
const landingStyle = /<style>([\s\S]*?)<\/style>/.exec(home)?.[1];
if (!landingStyle) throw new Error('build.mjs: the landing page has no <style>');
function corner(id) {
  const open = new RegExp(`<div class="vg[^"]*" id="${id}">`).exec(home);
  if (!open) throw new Error(`build.mjs: the landing page has no corner #${id}`);
  const tags = /<(\/?)div\b[^>]*>/g;
  tags.lastIndex = open.index + open[0].length;
  for (let depth = 1; depth > 0;) {
    const tag = tags.exec(home);
    if (!tag) throw new Error(`build.mjs: #${id} is never closed`);
    depth += tag[1] ? -1 : 1;
    if (!depth) return home.slice(open.index, tags.lastIndex);
  }
  return '';
}

let page = readFileSync(path.join(here, 'video.html'), 'utf8')
  .replace('{{landing-style}}', () => landingStyle)
  .replace(/\{\{corner:([a-z-]+)\}\}/g, (_, id) => corner(id));
page = withAssets(page);

// Every upright face, unsubset: the video is rendered here and nothing is served to readers.
let faces = '';
for (const face of ['inter-tight', 'newsreader', 'noto-serif-sc']) {
  const dir = path.join(root, 'node_modules/@fontsource-variable', face);
  for (const rule of readFileSync(path.join(dir, 'index.css'), 'utf8').match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    if (!/font-style:\s*normal/.test(rule)) continue;
    faces += `${rule.replace(/url\(\.\/files\/([^)]+)\)/g, (_, file) => {
      copyFileSync(path.join(dir, 'files', file), path.join(out, 'fonts', file));
      return `url(/fonts/${file})`;
    })}\n`;
  }
}
const css = withAssets(readFileSync(path.join(landing, 'site.css'), 'utf8')).replace('{{fonts}}', () => faces);

for (const [name, text] of [['index.html', page], ['site.css', css]]) {
  const left = text.match(/\{\{[^}]*\}\}/);
  if (left) throw new Error(`build.mjs: unfilled placeholder ${left[0]} in ${name}`);
}
writeFileSync(path.join(out, 'index.html'), page);
writeFileSync(path.join(out, 'assets/site.css'), css);
console.log(out);
