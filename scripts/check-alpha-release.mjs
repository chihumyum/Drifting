import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml');
const packageSection = cargo.match(/^\[package\]\s*([\s\S]*?)(?=^\[)/mu)?.[1] ?? '';
const cargoVersion = packageSection.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
const versions = new Map([
  ['package.json', packageJson.version],
  ['src-tauri/Cargo.toml', cargoVersion],
  ['src-tauri/tauri.conf.json', tauriConfig.version],
]);

const expected = packageJson.version;
for (const [file, version] of versions) {
  if (version !== expected) throw new Error(`${file} version ${version} does not match ${expected}`);
}
if (!/^0\.1\.\d+-alpha\.\d+$/u.test(expected)) {
  throw new Error(`Public Alpha version is not an immutable prerelease SemVer: ${expected}`);
}
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag && tag !== `app-v${expected}`) {
  throw new Error(`Tag ${tag} must exactly match app-v${expected}`);
}
if (tauriConfig.bundle?.macOS?.minimumSystemVersion !== '13.0') {
  throw new Error('Public Alpha must keep macOS minimumSystemVersion at 13.0');
}
if (tauriConfig.bundle?.createUpdaterArtifacts !== true) {
  throw new Error('Public Alpha must generate Tauri v2 updater artifacts');
}
for (const required of [
  'LICENSE',
  'PRIVACY.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'KNOWN_ISSUES.md',
  'SUPPORT.md',
  'docs/alpha-release-contract.md',
  'docs/google-drive-data-use.md',
  'docs/quick-start.md',
  `docs/releases/${expected}.md`,
  'docs/desktop-alpha-release-runbook.md',
  'docs/qa/google-drive-desktop-alpha-acceptance.md',
  'docs/qa/desktop-alpha-release-candidate.md',
]) {
  if (!fs.existsSync(path.join(root, required))) throw new Error(`Missing public release file: ${required}`);
}

const updaterSource = read('src-tauri/src/app_update.rs');
const updaterEndpoint = updaterSource.match(
  /const ALPHA_UPDATE_ENDPOINT: &str\s*=\s*\n?\s*"([^"]+)";/u,
)?.[1];
if (!updaterEndpoint?.endsWith('/updates/alpha/latest.json')) {
  throw new Error('Alpha updater must use the protected version-independent channel manifest');
}
if (updaterEndpoint.includes('/releases/latest')) {
  throw new Error('Alpha updater must not use GitHub releases/latest');
}

for (const workflow of fs.readdirSync(path.join(root, '.github/workflows'))) {
  if (!workflow.endsWith('.yml') && !workflow.endsWith('.yaml')) continue;
  const source = read(`.github/workflows/${workflow}`);
  for (const match of source.matchAll(/uses:\s*([^\s#]+)@([^\s#]+)/gu)) {
    if (!/^[0-9a-f]{40}$/u.test(match[2])) {
      throw new Error(`${workflow} action ${match[1]} is not pinned to a full commit SHA`);
    }
  }
}

process.stdout.write(`release contract verified for ${expected}\n`);
