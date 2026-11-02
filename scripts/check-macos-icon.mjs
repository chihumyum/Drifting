// --check: verify recorded native packaging evidence on any platform.
// --bundle <app>: inspect a freshly bundled app on macOS (also used in releases).
// --record <app>: inspect the app and regenerate the durable evidence.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file));
const json = file => JSON.parse(read(file).toString('utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const evidenceFile = 'docs/qa/macos-app-icon.json';
const sourceFiles = [
  'scripts/compile-macos-icon.mjs', 'scripts/check-macos-icon.mjs',
  'src-tauri/tauri.conf.json', 'src-tauri/tauri.macos.conf.json',
  'src/assets/icon.icns', 'src/assets/icon.icon/icon.json',
  ...readdirSync(path.join(root, 'src/assets/icon.icon/Assets')).sort()
    .map(name => `src/assets/icon.icon/Assets/${name}`),
];
// The release version lives in tauri.conf.json but never changes the icon;
// leave it out so bumping the version does not stale the packaging evidence.
const fingerprint = file => {
  if (file !== 'src-tauri/tauri.conf.json') return sha256(read(file));
  const { version: _version, ...config } = json(file);
  return sha256(JSON.stringify(config));
};
const sources = Object.fromEntries(sourceFiles.map(file => [file, fingerprint(file)]));
const appearances = ['ISAppearanceTintable', 'NSAppearanceNameAqua', 'NSAppearanceNameDarkAqua'];
const base = json('src-tauri/tauri.conf.json');
const mac = json('src-tauri/tauri.macos.conf.json');
const icon = json('src/assets/icon.icon/icon.json');
assert.equal(mac.build.beforeBundleCommand, 'node scripts/compile-macos-icon.mjs');
assert(mac.bundle.icon.includes('../out/macos-icon/Assets.car'), 'macOS must ship the layered catalog.');
assert(mac.bundle.icon.includes('../src/assets/icon.icns'), 'Keep the legacy macOS icon.');
assert(!base.bundle.icon.some(file => /\.(car|icon)$/.test(file)), 'Keep Apple catalogs out of other platforms.');
assert.equal(base.bundle.macOS.minimumSystemVersion, '13.0');

function validate(bundle) {
  assert.equal(bundle.minimumSystemVersion, base.bundle.macOS.minimumSystemVersion);
  assert.equal(bundle.iconName, 'icon');
  assert.equal(bundle.iconFile, 'icon.icns');
  assert.equal(bundle.fallbackSha256, sources['src/assets/icon.icns']);
  assert.equal(bundle.platform, 'macosx');
  for (const appearance of appearances) {
    assert(bundle.appearances.includes(appearance), `Missing ${appearance} catalog appearance.`);
    assert(bundle.stacks.some(stack => stack.appearance === appearance && stack.name === bundle.iconName),
      `Missing ${appearance} layered icon stack.`);
    for (const group of icon.groups) {
      const compiled = bundle.groups.find(item => item.name === `${bundle.iconName}/${group.name}` && item.appearance === appearance);
      assert(compiled, `Missing ${appearance}/${group.name} group.`);
      assert.equal(compiled.layers, group.layers.length);
    }
  }
  assert(bundle.iconSizes.includes(1024), 'Keep a full-resolution icon rendition.');
}

function inspect(appPath) {
  assert.equal(process.platform, 'darwin', 'Bundle inspection requires macOS assetutil.');
  const contents = path.resolve(appPath, 'Contents');
  const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')], { encoding: 'utf8' }));
  const catalog = path.join(contents, 'Resources/Assets.car');
  const assets = JSON.parse(execFileSync('xcrun', ['assetutil', '--info', catalog], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const bundle = {
    minimumSystemVersion: plist.LSMinimumSystemVersion,
    iconName: plist.CFBundleIconName,
    iconFile: plist.CFBundleIconFile,
    fallbackSha256: sha256(readFileSync(path.join(contents, 'Resources/icon.icns'))),
    catalogSha256: sha256(readFileSync(catalog)),
    compiler: assets[0].AssetStorageVersion,
    platform: assets[0].Platform,
    appearances: Object.keys(assets[0].Appearances).sort(),
    stacks: assets.filter(asset => asset.AssetType === 'IconImageStack').map(asset => ({ name: asset.Name, appearance: asset.Appearance })),
    groups: assets.filter(asset => asset.AssetType === 'IconGroup').map(asset => ({ name: asset.Name, appearance: asset.Appearance, layers: asset.LayerCount })),
    iconSizes: [...new Set(assets.filter(asset => asset.AssetType === 'Icon Image' && asset.Name === plist.CFBundleIconName).map(asset => asset.PixelWidth))].sort((a, b) => a - b),
  };
  validate(bundle);
  return bundle;
}

const [mode, appPath, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
if (mode === '--bundle' || mode === '--record') {
  assert(appPath, 'Pass the freshly generated .app path.');
  const bundle = inspect(appPath);
  if (mode === '--record') {
    writeFileSync(path.join(root, evidenceFile), JSON.stringify({
      kind: 'macos-layered-app-icon', sources, bundle,
      boundary: 'Real Tauri packaging of an existing client executable, without launching it or accessing a database. Catalog metadata validates light, dark and mono stacks; macOS derives Clear/Tinted from mono. Dock switching and pre-26 hardware are not automated acceptance.',
    }, null, 2) + '\n');
  }
} else {
  assert.equal(mode, '--check');
  assert.equal(appPath, undefined);
  const evidence = json(evidenceFile);
  assert.equal(evidence.kind, 'macos-layered-app-icon');
  assert.deepEqual(evidence.sources, sources, 'Icon packaging evidence is stale; rerun --record with a fresh bundle.');
  validate(evidence.bundle);
}
console.log('macOS app icon passed: light/dark/mono layered catalog, matching Info.plist, unchanged legacy icon and macOS 13 minimum.');
