// Adds one platform's signed updater artifact to an existing Tauri updater
// manifest (latest.json). The macOS release job writes the manifest; the
// Windows release job adds windows-x86_64 and windows-aarch64 to it, so a
// Windows build that fails never holds back the macOS release (docs/releasing.md).
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PLATFORM = /^(darwin|windows|linux)-(x86_64|aarch64)$/u;

export function mergeUpdateManifest(manifest, { platform, url, signature, version }) {
  if (!PLATFORM.test(platform)) throw new Error(`Unknown updater platform ${platform}`);
  if (version && manifest.version !== version) {
    throw new Error(`latest.json is for ${manifest.version}, not ${version}`);
  }
  const location = new URL(url);
  if (location.protocol !== 'https:') throw new Error('Updater artifact URL must use HTTPS');
  const trimmed = signature.trim();
  if (!trimmed) throw new Error('Updater signature is empty');
  return {
    ...manifest,
    platforms: { ...manifest.platforms, [platform]: { signature: trimmed, url: location.toString() } },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    values.set(process.argv[index], process.argv[index + 1]);
  }
  const required = (key) => {
    const value = values.get(key)?.trim();
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const file = path.resolve(required('--manifest'));
  const merged = mergeUpdateManifest(JSON.parse(fs.readFileSync(file, 'utf8')), {
    platform: required('--platform'),
    url: required('--url'),
    signature: fs.readFileSync(required('--signature-file'), 'utf8'),
    version: values.get('--version'),
  });
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
}
