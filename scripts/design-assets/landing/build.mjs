#!/usr/bin/env node
// Build drifting.cc's home page and the look its other pages share:
//   node scripts/design-assets/landing/build.mjs [out-dir] [--og card.png]
// Generates the localized homes, shared assets, fonts and sitemap. The
// site's own information pages beside them supply the sitemap dates.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOMES, ORIGIN } from './locales.mjs';
import { charSeaScript } from '../../../src/renderer/lib/char-sea/char-sea-text.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const args = process.argv.slice(2);
const ogAt = args.indexOf('--og');
const og = ogAt >= 0 ? path.resolve(args[ogAt + 1]) : null;
const [outArg] = args.filter((arg, index) => !arg.startsWith('--') && !(ogAt >= 0 && index === ogAt + 1));
const out = path.resolve(outArg ?? path.join(root, 'out/landing'));

const homeFiles = HOMES.map(({ file }) => file);
const copy = new Map(HOMES.map(({ locale }) => [locale, JSON.parse(readFileSync(path.join(here, 'copy', locale + '.json'), 'utf8'))]));
const keys = Object.keys(copy.get('en')).sort().join('\n');
for (const [locale, strings] of copy) {
  if (Object.keys(strings).sort().join('\n') !== keys || Object.values(strings).some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error(`Incomplete landing copy for ${locale}`);
  }
}

// Only what this script writes is replaced: the site's own pages beside it stay,
// and so does the sharing card unless a new one is given.
for (const own of [...homeFiles, 'assets', 'fonts', ...(og ? ['og.png'] : [])]) rmSync(path.join(out, own), { recursive: true, force: true });
mkdirSync(path.join(out, 'assets'), { recursive: true });
mkdirSync(path.join(out, 'fonts'), { recursive: true });

// The scripts: the sea, frame and cover straight from the app's source, and
// the bar every page shares (site.mjs).
await build({
  entryPoints: { landing: path.join(here, 'entry.mjs'), pages: path.join(here, 'pages.mjs'), prefs: path.join(here, 'prefs.js') },
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

// The masks and icons the page and the shared sheet name, each copied once.
const design = path.join(root, 'src/assets/design');
const withAssets = (text) => text.replace(/\{\{asset:([^}]+)\}\}/g, (_, rel) => {
  const name = rel.replaceAll('/', '-');
  copyFileSync(path.join(design, rel), path.join(out, 'assets', name));
  return `/assets/${name}`;
});
// The version the hero and the structured data name is the app's own.
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const template = withAssets(readFileSync(path.join(here, 'index.html'), 'utf8')).replaceAll('{{version}}', version);
// The download buttons fetch the installers of the latest published release
// by name, so the site is built from the version that release carries
// (docs/releasing.md: rebuild and deploy the site after Publish).
const RELEASE = 'https://github.com/chihumyum/Drifting/releases/latest/download/';
const downloads = {
  'download-mac': `${RELEASE}Drifting_${version}_macos_arm64.dmg`,
  'download-windows': `${RELEASE}Drifting_${version}_windows_x64-setup.exe`,
  'download-windows-arm': `${RELEASE}Drifting_${version}_windows_arm64-setup.exe`,
};
const withDownloads = (text) => text.replace(/\{\{(download-[a-z-]+)\}\}/g, (token, key) => downloads[key] ?? token);
let css = withAssets(readFileSync(path.join(here, 'site.css'), 'utf8'));

// The fonts, served from the site so a visit asks nothing of another host:
// only the slices of each face that hold a character a page or the sea
// writes — this page, and the site's information pages already in the
// directory. The families keep the app's names, so the sea's own font stacks
// (char-sea-text.ts) find them.
const others = readdirSync(out).filter((name) => name.endsWith('.html') && !homeFiles.includes(name));
const pages = HOMES.map((home) => [home.file, renderHome(home)]);
const written = [pages.map(([, html]) => html).join(''), readFileSync(path.join(root, 'src/renderer/lib/char-sea/char-sea-text.ts'), 'utf8'),
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

for (const [name, text] of [...pages, ['site.css', css]]) {
  const left = text.match(/\{\{[^}]*\}\}/);
  if (left) throw new Error(`build.mjs: unfilled placeholder ${left[0]} in ${name}`);
}
if (og) copyFileSync(og, path.join(out, 'og.png'));
writeFileSync(path.join(out, 'assets/site.css'), css);

function attribute(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function jsonScript(data) {
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2).replace(/</g, '\\u003c')}\n</script>`;
}

function renderHome(home) {
  const { locale, path: urlPath, cjk, infoLang } = home;
  const strings = copy.get(locale);
  const title = attribute(strings['meta.title']);
  const description = attribute(strings['meta.description']);
  const url = ORIGIN + urlPath;
  const alternates = HOMES.map(({ path, hreflang }) => `<link rel="alternate" hreflang="${hreflang}" href="${ORIGIN}${path}">`);
  const metadata = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${url}">`,
    ...alternates,
    `<link rel="alternate" hreflang="x-default" href="${ORIGIN}/">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Drifting">',
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:locale" content="${home.ogLocale}">`,
    ...HOMES.filter((other) => other !== home).map(({ ogLocale }) => `<meta property="og:locale:alternate" content="${ogLocale}">`),
    `<meta property="og:image" content="${ORIGIN}/og.png">`,
    '<meta property="og:image:type" content="image/png">',
    '<meta property="og:image:width" content="2560">',
    '<meta property="og:image:height" content="1280">',
    `<meta property="og:image:alt" content="${attribute(strings['meta.image'])}">`,
    '<meta name="twitter:card" content="summary_large_image">',
  ].join('\n');

  const schema = jsonScript({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'Drifting', url: ORIGIN + '/', inLanguage: HOMES.map(({ hreflang }) => hreflang) },
      {
        '@type': 'SoftwareApplication', name: 'Drifting', url, inLanguage: home.hreflang,
        image: ORIGIN + '/og.png', description: strings['meta.description'], softwareVersion: version,
        // Apple Silicon Macs; Windows on x64 and Arm (a preview).
        operatingSystem: 'macOS 13+, Windows 10, Windows 11',
        downloadUrl: 'https://github.com/chihumyum/Drifting/releases/latest',
        license: 'https://spdx.org/licenses/AGPL-3.0-or-later.html',
        isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        sameAs: ['https://github.com/chihumyum/Drifting'],
      },
    ],
  });
  const label = attribute(strings['language.label']);
  const links = HOMES.map((option) => {
    const href = option.path === '/' ? '/#en' : option.path;
    return `<a href="${href}" lang="${option.locale}" hreflang="${option.hreflang}" data-locale="${option.locale}"${option === home ? ' aria-current="page"' : ''}>${option.label}</a>`;
  }).join('\n        ');
  const menu = `<details class="language-switcher">
      <summary class="glass glass--rest pill pill--sm" aria-label="${label} · ${home.label}">${home.label}</summary>
      <nav aria-label="${label}">
        ${links}
      </nav>
    </details>`;
  const replacements = {
    metadata, 'software-schema': schema, 'language-menu': menu, 'html-lang': locale, locale,
    script: cjk ? 'cjk' : 'latin', 'cjk-attr': cjk ? ' data-script="cjk"' : '',
    'sea-script': JSON.stringify(charSeaScript(locale)),
    'agent-before': JSON.stringify(strings['story.agentBefore']).replace(/</g, '\\u003c'),
    'theme-attrs': ['system', 'light', 'dark'].map((theme) => `data-theme-${theme}="${attribute(strings['theme.' + theme])}"`).join(' '),
    'theme-label': attribute(strings['theme.system']),
    'information-note': locale === 'en' || locale === 'zh-CN' ? '' : `<p class="information-note">${strings['footer.information']}</p>`,
    readme: infoLang === 'zh'
      ? 'https://github.com/chihumyum/Drifting/blob/main/README.zh-CN.md#%E4%BB%8E%E6%BA%90%E7%A0%81%E6%9E%84%E5%BB%BA'
      : 'https://github.com/chihumyum/Drifting#build-from-source',
    'word-count': new Intl.NumberFormat(locale).format(12480),
    ...downloads,
  };
  let html = template.replace(/\{\{([^}]+)\}\}/g, (token, key) => {
    if (key.startsWith('copy:')) return strings[key.slice(5)] === undefined ? token : withDownloads(strings[key.slice(5)]);
    if (key.startsWith('date:')) {
      const [month, day] = key.slice(5).split('-').map(Number);
      return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2026, month - 1, day));
    }
    return replacements[key] ?? token;
  });
  for (const name of ['support', 'privacy', 'terms']) html = html.replaceAll(`href="/${name}"`, `href="/${name}#${infoLang}"`);
  return withQuestions(html, home.hreflang);
}

// The questions sheet again as FAQPage structured data, in the page's language,
// so the answers a reader sees are the ones a search engine or a model reads.
function withQuestions(html, lang) {
  const sheet = /<section\b[^>]*\sid="faq"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1];
  if (!sheet) throw new Error('build.mjs: the questions sheet (#faq) is missing');
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  const plain = (fragment) => fragment.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => entities[name]).replace(/\s+/g, ' ').trim();
  const questions = [...sheet.matchAll(/<div class="q">\s*<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map(([, question, answer]) => ({
    '@type': 'Question',
    name: plain(question),
    acceptedAnswer: { '@type': 'Answer', text: plain(answer) },
  }));
  if (questions.length !== (sheet.match(/<h3>/g) ?? []).length) throw new Error('build.mjs: every question in #faq needs its <p> answer right under its <h3>');
  return html.replace('</head>', jsonScript({
    '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: lang, mainEntity: questions,
  }) + '\n</head>');
}

for (const [file, html] of pages) writeFileSync(path.join(out, file), html);
const sitemap = [
  ...HOMES.map(({ path }) => ({ path })),
  ...others.filter((name) => name !== '404.html').map((name) => {
    const text = readFileSync(path.join(out, name), 'utf8');
    const lastmod = /Last updated (\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
    return { path: '/' + name.slice(0, -5), lastmod };
  }),
];
writeFileSync(path.join(out, 'sitemap.xml'), [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...sitemap.map(({ path, lastmod }) => `  <url><loc>${ORIGIN}${path}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`),
  '</urlset>', '',
].join('\n'));
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
