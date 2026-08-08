#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng } from './macos-icon.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(root, 'src', 'assets', 'mobile-icon.json');
const androidRes = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');
const legacyIosAppIcon = path.join(
  root,
  'src-tauri',
  'gen',
  'apple',
  'Assets.xcassets',
  'AppIcon.appiconset',
);
// The Tauri CLI discovers initialized mobile projects relative to the output
// directory's parent, so keep the disposable desktop outputs under src-tauri.
const tempOutput = mkdtempSync(path.join(root, 'src-tauri', '.mobile-icons-'));
const legacyIosBackup = path.join(tempOutput, 'legacy-ios-appiconset');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const adaptiveIconXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <foreground android:drawable="@mipmap/ic_launcher_foreground" />
  <background android:drawable="@mipmap/ic_launcher_background" />
  <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`;

function resizePremultipliedBilinear(source, targetWidth, targetHeight) {
  const output = Buffer.alloc(targetWidth * targetHeight * 4);
  const sx = source.width / targetWidth;
  const sy = source.height / targetHeight;

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.max(0, Math.min(source.height - 1, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fy = sourceY - y0;

    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.max(0, Math.min(source.width - 1, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const fx = sourceX - x0;
      const samples = [
        [x0, y0, (1 - fx) * (1 - fy)],
        [x1, y0, fx * (1 - fy)],
        [x0, y1, (1 - fx) * fy],
        [x1, y1, fx * fy],
      ];

      let alpha = 0;
      const premultiplied = [0, 0, 0];
      for (const [sampleX, sampleY, weight] of samples) {
        const offset = (sampleY * source.width + sampleX) * 4;
        const sampleAlpha = source.data[offset + 3] / 255;
        alpha += sampleAlpha * weight;
        for (let channel = 0; channel < 3; channel += 1) {
          premultiplied[channel] += source.data[offset + channel] * sampleAlpha * weight;
        }
      }

      const outputOffset = (y * targetWidth + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        output[outputOffset + channel] = alpha > 0 ? Math.round(premultiplied[channel] / alpha) : 0;
      }
      output[outputOffset + 3] = Math.round(alpha * 255);
    }
  }

  return output;
}

function correctHdpiLegacyIcon(name) {
  // Tauri CLI 2.11.4 emits the hdpi legacy launcher at 49px. Android's density
  // contract is 72px, so derive that compatibility asset from the 96px xhdpi
  // composite. API 26+ continues to use the adaptive layers directly.
  const sourcePath = path.join(androidRes, 'mipmap-xhdpi', name);
  const outputPath = path.join(androidRes, 'mipmap-hdpi', name);
  const source = decodePng(sourcePath);
  encodePng(outputPath, 72, 72, resizePremultipliedBilinear(source, 72, 72));
}

if (existsSync(legacyIosAppIcon)) {
  cpSync(legacyIosAppIcon, legacyIosBackup, { recursive: true });
}

try {
  execFileSync(pnpm, ['exec', 'tauri', 'icon', manifest, '--output', tempOutput], {
    cwd: root,
    stdio: 'inherit',
  });
  writeFileSync(path.join(androidRes, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptiveIconXml);
  writeFileSync(
    path.join(androidRes, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'),
    adaptiveIconXml,
  );
  correctHdpiLegacyIcon('ic_launcher.png');
  correctHdpiLegacyIcon('ic_launcher_round.png');
  console.log('✓ iOS fallback and Android adaptive icon assets generated');
} finally {
  if (existsSync(legacyIosBackup)) {
    rmSync(legacyIosAppIcon, { recursive: true, force: true });
    cpSync(legacyIosBackup, legacyIosAppIcon, { recursive: true });
  }
  rmSync(tempOutput, { recursive: true, force: true });
}
