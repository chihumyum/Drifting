// Release preflight (docs/releasing.md): the version agrees everywhere, the tag
// names it, release notes exist, the bundle still produces signed updater
// artifacts for the endpoint the app polls, and every Action is pinned.
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
  if (tauriConfig.bundle?.createUpdaterArtifacts !== true) {
    errors.push('tauri.conf.json must keep bundle.createUpdaterArtifacts');
  }
  if (!read('src-tauri/src/app_update.rs').includes(`"${UPDATE_ENDPOINT}"`)) {
    errors.push(`src-tauri/src/app_update.rs must poll ${UPDATE_ENDPOINT}`);
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
