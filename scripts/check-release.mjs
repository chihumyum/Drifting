// Release preflight (docs/releasing.md): the version agrees everywhere, the tag
// names it, release notes exist, the README's screenshots were captured for it,
// the bundle still produces signed updater artifacts for the endpoint the app
// polls, build tools stay unstripped, the app is built with Xcode 26 or later,
// and every Action is pinned.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const UPDATE_ENDPOINT = 'https://github.com/chihumyum/Drifting/releases/latest/download/latest.json';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

export function checkRelease({ tag } = {}) {
  const errors = [];
  const packageJson = JSON.parse(read('package.json'));
  const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
  const cargo = read('src-tauri/Cargo.toml');
  const packageSection = cargo.match(/^\[package\]\s*([\s\S]*?)(?=^\[)/mu)?.[1] ?? '';
  const version = packageJson.version;

  for (const [file, value] of [
    ['src-tauri/Cargo.toml', packageSection.match(/^version\s*=\s*"([^"]+)"/mu)?.[1]],
    ['src-tauri/tauri.conf.json', tauriConfig.version],
  ]) {
    if (value !== version) errors.push(`${file} version ${value} does not match package.json ${version}`);
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/u.test(version)) errors.push(`version ${version} is not SemVer`);
  if (tag && tag !== `v${version}`) errors.push(`tag ${tag} must be v${version}`);
  if (!fs.existsSync(path.join(root, `docs/releases/${version}.md`))) {
    errors.push(`release notes docs/releases/${version}.md are missing`);
  }
  // The README shows this version's screenshots (pnpm release:screenshots --readme).
  const screenshots = 'docs/screenshots/manifest.json';
  if (!fs.existsSync(path.join(root, screenshots))) {
    errors.push(`${screenshots} is missing: run pnpm release:screenshots --readme`);
  } else {
    const shots = JSON.parse(read(screenshots));
    if (shots.version !== version) {
      errors.push(`the README screenshots are from ${shots.version}, not ${version}: run pnpm release:screenshots --readme`);
    }
    const readme = read('README.md');
    for (const entry of shots.files ?? []) {
      if (!fs.existsSync(path.join(root, 'docs/screenshots', entry.file))) errors.push(`docs/screenshots/${entry.file} is missing`);
      if (!readme.includes(`docs/screenshots/${entry.file}`)) errors.push(`README.md must show docs/screenshots/${entry.file}`);
    }
  }
  if (tauriConfig.bundle?.createUpdaterArtifacts !== true) {
    errors.push('tauri.conf.json must keep bundle.createUpdaterArtifacts');
  }
  // Stripped proc-macro dylibs from Xcode 27's toolchain do not load, which
  // stops a release build before it reaches the app.
  const buildOverride = cargo.split(/^(?=\[)/mu).find((section) => section.startsWith('[profile.release.build-override]')) ?? '';
  if (!/^strip\s*=\s*"none"/mu.test(buildOverride)) {
    errors.push('src-tauri/Cargo.toml must keep [profile.release.build-override] strip = "none"');
  }
  if (!read('src-tauri/src/app_update.rs').includes(`"${UPDATE_ENDPOINT}"`)) {
    errors.push(`src-tauri/src/app_update.rs must poll ${UPDATE_ENDPOINT}`);
  }
  // An app linked against an SDK older than macOS 26 gets the older title bar,
  // and its traffic lights sit lower than the position the app sets.
  if (!/DEVELOPER_DIR: \/Applications\/Xcode_(?:2[6-9]|[3-9]\d)[\d.]*\.app\/Contents\/Developer/u.test(read('.github/workflows/release.yml'))) {
    errors.push('release.yml must build with Xcode 26 or later (DEVELOPER_DIR)');
  }
  for (const workflow of fs.readdirSync(path.join(root, '.github/workflows'))) {
    if (!/\.ya?ml$/u.test(workflow)) continue;
    for (const match of read(`.github/workflows/${workflow}`).matchAll(/uses:\s*([^\s#]+)@([^\s#]+)/gu)) {
      if (!/^[0-9a-f]{40}$/u.test(match[2])) errors.push(`${workflow}: ${match[1]} is not pinned to a commit SHA`);
    }
  }
  return { version, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const { version, errors } = checkRelease({ tag: process.argv[2] ?? process.env.GITHUB_REF_NAME });
  if (errors.length) {
    for (const error of errors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`release ${version} is ready to build\n`);
  }
}
