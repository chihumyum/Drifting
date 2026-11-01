#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng } from './macos-icon.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appleRoot = path.join(root, 'src-tauri', 'gen', 'apple');
const androidRes = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');

const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');

function alphaBounds(image, threshold = 2) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] <= threshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  assert.ok(maxX >= minX && maxY >= minY, 'icon layer must contain visible pixels');
  return { width: maxX - minX + 1, height: maxY - minY + 1 };
}

const iconComposer = path.join(root, 'src', 'assets', 'icon.icon');
assert.ok(
  existsSync(path.join(iconComposer, 'icon.json')),
  'canonical Icon Composer file is missing',
);
const iconDocument = JSON.parse(read('src/assets/icon.icon/icon.json'));
const layerImages = (iconDocument.groups ?? []).flatMap((group) =>
  (group.layers ?? []).map((layer) => layer['image-name']),
);
assert.ok(layerImages.length > 0, 'Icon Composer file must declare its layers');
const androidForeground = read('src/assets/icon-android-foreground.svg');
for (const layerImage of layerImages) {
  assert.ok(layerImage, 'every Icon Composer layer must name its image');
  assert.ok(
    existsSync(path.join(iconComposer, 'Assets', layerImage)),
    `Icon Composer layer image ${layerImage} is missing`,
  );
  assert.ok(
    androidForeground.includes(`icon.icon/Assets/${layerImage}`),
    `Android foreground must stack the Icon Composer layer ${layerImage}`,
  );
}

const projectSpec = readFileSync(path.join(appleRoot, 'project.yml'), 'utf8');
const pbxProject = readFileSync(
  path.join(appleRoot, 'drifting.xcodeproj', 'project.pbxproj'),
  'utf8',
);
assert.match(projectSpec, /path: \.\.\/\.\.\/\.\.\/src\/assets\/icon\.icon/);
assert.match(projectSpec, /ASSETCATALOG_COMPILER_APPICON_NAME: icon/);
assert.match(pbxProject, /icon\.icon in Resources/);
assert.equal(
  [...pbxProject.matchAll(/ASSETCATALOG_COMPILER_APPICON_NAME = icon;/g)].length,
  2,
  'debug and release must both select the Icon Composer document',
);
assert.doesNotMatch(
  pbxProject,
  /Assets\.xcassets in Resources/,
  'the legacy AppIcon catalog must not compete with icon.icon',
);

const manifest = JSON.parse(read('src/assets/mobile-icon.json'));
assert.equal(manifest.android_fg_scale, 54.9);
assert.equal(manifest.android_fg, manifest.android_monochrome);

for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
  const xml = readFileSync(path.join(androidRes, 'mipmap-anydpi-v26', name), 'utf8');
  assert.match(xml, /@mipmap\/ic_launcher_foreground/);
  assert.match(xml, /@mipmap\/ic_launcher_background/);
  assert.match(xml, /@mipmap\/ic_launcher_monochrome/);
}

const densities = {
  mdpi: { adaptive: 108, legacy: 48 },
  hdpi: { adaptive: 162, legacy: 72 },
  xhdpi: { adaptive: 216, legacy: 96 },
  xxhdpi: { adaptive: 324, legacy: 144 },
  xxxhdpi: { adaptive: 432, legacy: 192 },
};

for (const [density, sizes] of Object.entries(densities)) {
  const folder = path.join(androidRes, `mipmap-${density}`);
  for (const name of ['ic_launcher_foreground.png', 'ic_launcher_monochrome.png']) {
    const image = decodePng(path.join(folder, name));
    assert.deepEqual([image.width, image.height], [sizes.adaptive, sizes.adaptive]);
    const bounds = alphaBounds(image);
    const safeLimit = Math.ceil((sizes.adaptive * 59.4) / 108) + 2;
    assert.ok(
      bounds.width <= safeLimit && bounds.height <= safeLimit,
      `${density}/${name} exceeds the configured 90% safe-zone footprint`,
    );
  }

  const background = decodePng(path.join(folder, 'ic_launcher_background.png'));
  assert.deepEqual([background.width, background.height], [sizes.adaptive, sizes.adaptive]);
  const top = background.data.subarray(
    Math.floor(sizes.adaptive / 2) * 4,
    Math.floor(sizes.adaptive / 2) * 4 + 4,
  );
  const bottomOffset = ((sizes.adaptive - 1) * sizes.adaptive + Math.floor(sizes.adaptive / 2)) * 4;
  const bottom = background.data.subarray(bottomOffset, bottomOffset + 4);
  assert.equal(top[3], 255);
  assert.deepEqual(
    [...top],
    [...bottom],
    `${density} background must be the icon's flat paper colour`,
  );

  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
    const image = decodePng(path.join(folder, name));
    assert.deepEqual([image.width, image.height], [sizes.legacy, sizes.legacy]);
  }
}

console.log('✓ mobile icon source, iOS project wiring, Android layers, safe zone and densities');
