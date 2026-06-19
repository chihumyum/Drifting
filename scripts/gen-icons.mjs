#!/usr/bin/env node
// Generate app icons (icns/ico/png) from a single 1024x1024 master PNG.
//
//   Master:  src/assets/icon-master.png   (1024x1024, square, with alpha)
//   Output:  src/assets/icon.icns         (macOS app / Dock / DMG)
//            src/assets/icon.ico          (Windows installer)
//            src/assets/icon.png          (Linux .deb — 512px)
//
// macOS only for the .icns step (uses built-in `sips` + `iconutil`).
// The .ico step shells out to `png-to-ico` via npx (no dependency added).
//
//   pnpm icons

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'src', 'assets');
const master = path.join(assets, 'icon-master.png');

function sh(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
}

if (!existsSync(master)) {
  console.error(`\n✗ Master not found: ${path.relative(root, master)}`);
  console.error('  Put a 1024×1024 PNG there, then re-run `pnpm icons`.\n');
  process.exit(1);
}

// Sanity-check the master dimensions (warn, don't block).
try {
  const out = sh('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', master]).toString();
  const w = +(out.match(/pixelWidth: (\d+)/)?.[1] ?? 0);
  const h = +(out.match(/pixelHeight: (\d+)/)?.[1] ?? 0);
  if (w !== h) console.warn(`⚠ Master is ${w}×${h} — not square. Icon may look stretched.`);
  if (w < 1024) console.warn(`⚠ Master is ${w}px — under 1024 means a blurry Retina @2x slot.`);
} catch { /* sips missing — handled below when we actually use it */ }

const tmp = mkdtempSync(path.join(tmpdir(), 'drifting-icons-'));
const resize = (size, dest) => sh('sips', ['-z', String(size), String(size), master, '--out', dest]);

try {
  // ---- macOS .icns ----
  const iconset = path.join(tmp, 'icon.iconset');
  mkdirSync(iconset);
  const icnsSlots = [
    [16, '16x16'], [32, '16x16@2x'],
    [32, '32x32'], [64, '32x32@2x'],
    [128, '128x128'], [256, '128x128@2x'],
    [256, '256x256'], [512, '256x256@2x'],
    [512, '512x512'], [1024, '512x512@2x'],
  ];
  for (const [size, label] of icnsSlots) {
    resize(size, path.join(iconset, `icon_${label}.png`));
  }
  sh('iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'icon.icns')]);
  console.log('✓ src/assets/icon.icns');

  // ---- Linux .png (512) ----
  resize(512, path.join(assets, 'icon.png'));
  console.log('✓ src/assets/icon.png');

  // ---- Windows .ico (multi-size via png-to-ico) ----
  const icoSizes = [256, 128, 64, 48, 32, 16];
  const icoInputs = icoSizes.map((s) => {
    const p = path.join(tmp, `ico-${s}.png`);
    resize(s, p);
    return p;
  });
  const icoOut = path.join(assets, 'icon.ico');
  execFileSync('npx', ['--yes', 'png-to-ico', ...icoInputs], {
    stdio: ['ignore', openSync(icoOut, 'w'), 'inherit'],
  });
  console.log('✓ src/assets/icon.ico');

  console.log('\nDone. Package with `pnpm make` (or `pnpm package`) to see them.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
