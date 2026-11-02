// Compile the canonical layered icon before Tauri signs/packages the app.
// Keep the checked-in .icns as the fallback for macOS before 26.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/macos-icon');
const config = JSON.parse(readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
assert.equal(process.platform, 'darwin', 'macOS icon compilation requires Xcode on macOS.');
mkdirSync(output, { recursive: true });
// A failed compiler must never leave a previous build's catalog available.
rmSync(path.join(output, 'Assets.car'), { force: true });
execFileSync('xcrun', [
  'actool', path.join(root, 'src/assets/icon.icon'),
  '--compile', output,
  '--output-format', 'human-readable-text',
  '--output-partial-info-plist', path.join(output, 'generated.plist'),
  '--app-icon', 'icon',
  '--target-device', 'mac',
  '--minimum-deployment-target', config.bundle.macOS.minimumSystemVersion,
  '--platform', 'macosx',
], {
  cwd: root,
  // Xcode 27's pooled ibtoold can retain broken file descriptors between
  // invocations. Run this compiler directly, without killing shared daemons.
  // Tauri 2.11.4 also hard-codes 26.0 and renames the input in its .icon path;
  // consume our catalog instead. See docs/qa/macos-app-icon.md.
  env: { ...process.env, IBToolNeverDeque: 'YES' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
assert(existsSync(path.join(output, 'Assets.car')), 'actool did not produce the layered icon catalog. Use Xcode 26 or later.');
