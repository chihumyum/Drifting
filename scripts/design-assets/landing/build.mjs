#!/usr/bin/env node
// Build drifting.cc's home page and the look its other pages share:
//   node scripts/design-assets/landing/build.mjs [out-dir] [--og card.png]
// Writes the home page in English (index.html, served at /) and in Chinese
// (zh.html, served at /zh), assets/ (site.css, prefs.js, the landing and
// information page scripts, masks and icons) and fonts/ (out/landing by
// default), replacing only those; --og copies the sharing card in as og.png.
// Point it at the site's served directory to update the site: the information
// pages there link /assets/site.css, /assets/prefs.js and /assets/pages.js.
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

// The home page in each language: the file, and its <html lang>.
const HOMES = { en: { file: 'index.html', lang: 'en' }, zh: { file: 'zh.html', lang: 'zh-CN' } };
const homeFiles = Object.values(HOMES).map((home) => home.file);

// Only what this script writes is replaced: the site's own pages beside it stay,
// and so does the sharing card unless a new one is given.
for (const own of [...homeFiles, 'assets', 'fonts', ...(og ? ['og.png'] : [])]) rmSync(path.join(out, own), { recursive: true, force: true });
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
// The version the hero and the structured data name is the app's own.
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
let page = withAssets(readFileSync(path.join(here, 'index.html'), 'utf8')).replaceAll('{{version}}', version);
let css = withAssets(readFileSync(path.join(here, 'site.css'), 'utf8'));

// The fonts, served from the site so a visit asks nothing of another host:
// only the slices of each face that hold a character a page or the sea
// writes — this page, and the site's information pages already in the
// directory. The families keep the app's names, so the sea's own font stacks
// (char-sea-text.ts) find them.
const others = readdirSync(out).filter((name) => name.endsWith('.html') && !homeFiles.includes(name));
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

// The page says everything in both languages, each piece marked data-l. A page
// in one language keeps the pieces marked with it, dropping the mark, and drops
// the others' with all they hold (and their line, when they had one to
// themselves), so a search engine reads one language at one address.
function inLanguage(html, lang) {
  const marked = /<([a-z][a-z0-9]*)\b([^<>]*?)\sdata-l="(zh|en)"([^<>]*)>/g;
  let kept = '';
  let at = 0;
  for (const match of html.matchAll(marked)) {
    if (match.index < at) continue;
    const [tag, name, before, which, after] = match;
    kept += html.slice(at, match.index);
    at = match.index + tag.length;
    if (which === lang) {
      kept += `<${name}${before}${after}>`;
      continue;
    }
    if (!['link', 'meta'].includes(name)) {
      const nested = new RegExp(`<(/?)${name}\\b[^>]*>`, 'g');
      nested.lastIndex = at;
      for (let depth = 1; depth > 0;) {
        const next = nested.exec(html);
        if (!next) throw new Error(`build.mjs: <${name} data-l="${which}"> is never closed`);
        depth += next[1] ? -1 : 1;
        at = nested.lastIndex;
      }
    }
    const lead = /\n[ \t]*$/.exec(kept);
    const trail = /[ \t]*\n/y;
    trail.lastIndex = at;
    if (lead && trail.test(html)) {
      kept = kept.slice(0, lead.index + 1);
      at = trail.lastIndex;
    }
  }
  return kept + html.slice(at);
}
const informationPages = others.filter((name) => name !== '404.html').map((name) => name.slice(0, -'.html'.length));
if (!page.includes('<html lang="en">')) throw new Error('build.mjs: index.html must open with <html lang="en">');
for (const [lang, home] of Object.entries(HOMES)) {
  let text = inLanguage(page, lang).replace('<html lang="en">', `<html lang="${home.lang}" data-lang="${lang}">`);
  // A link to an information page opens it in this page's language.
  for (const name of informationPages) text = text.replaceAll(`href="/${name}"`, `href="/${name}#${lang}"`);
  if (/\sdata-l=/.test(text)) throw new Error(`build.mjs: ${home.file} still holds a data-l mark`);
  writeFileSync(path.join(out, home.file), text);
}
for (const name of others) {
  const text = readFileSync(path.join(out, name), 'utf8');
  for (const asset of ['/assets/site.css', '/assets/prefs.js', '/assets/pages.js']) {
    if (text.includes(asset) && !existsSync(path.join(out, asset))) throw new Error(`build.mjs: ${name} links ${asset}, which was not written`);
  }
}

const size = (dir) => readdirSync(dir).reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0);
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
console.log(`${out}
${homeFiles.map((file) => `  ${file.padEnd(11)} ${kb(statSync(path.join(out, file)).size)}`).join('\n')}
  assets/    ${readdirSync(path.join(out, 'assets')).length} files, ${kb(size(path.join(out, 'assets')))}
  fonts/      ${readdirSync(path.join(out, 'fonts')).length} files, ${kb(size(path.join(out, 'fonts')))}${og ? '\n  og.png' : ''}${others.length ? `\n  fonts cover ${others.join(', ')}` : ''}`);
